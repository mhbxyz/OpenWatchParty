using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using OpenWatchParty.Plugin.Controllers;
using Xunit;

namespace OpenWatchParty.Plugin.Tests;

public sealed class ClientAssetPublicationTests
{
    private static readonly Regex ModulePattern = new(
        "loadScript\\(\\s*['\"](?<path>[^'\"]+\\.js)['\"]\\s*\\)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    [Fact]
    public void EveryModuleDeclaredByLoaderIsEmbeddedAndServed()
    {
        var loader = ReadCanonicalLoader();
        var modules = GetDeclaredModules(loader);
        var assembly = typeof(OpenWatchPartyController).Assembly;
        var resources = assembly.GetManifestResourceNames();

        Assert.Equal(26, modules.Count);
        Assert.Equal(modules.Count, modules.Distinct(StringComparer.Ordinal).Count());

        var loaderResult = Assert.IsType<ContentResult>(CreateController().GetClientScript());
        Assert.Equal(loader, loaderResult.Content);
        Assert.Contains("const base = '/OpenWatchParty/Client'", loaderResult.Content, StringComparison.Ordinal);
        Assert.DoesNotContain("/web/plugins/openwatchparty", loaderResult.Content, StringComparison.Ordinal);

        foreach (var module in modules)
        {
            var resourceName = "OpenWatchParty.Plugin.Web." + module.Replace('/', '.');
            Assert.Contains(resourceName, resources);
            using var stream = assembly.GetManifestResourceStream(resourceName);
            Assert.NotNull(stream);
            Assert.True(stream.Length > 0, $"Embedded module {module} should not be empty");

            var result = Assert.IsType<FileContentResult>(CreateController().GetClientModule(module));
            Assert.Equal("text/javascript; charset=utf-8", result.ContentType);
            Assert.NotEmpty(result.FileContents);
        }

        Assert.DoesNotContain(resources, name => name.Contains(".Web.tests.", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("../plugin.js")]
    [InlineData("utils/../plugin.js")]
    [InlineData("/state.js")]
    [InlineData("utils\\time.js")]
    [InlineData("utils//time.js")]
    [InlineData("%2e%2e%2fplugin.js")]
    public void InvalidModulePathsAreRejected(string? path)
    {
        var result = CreateController().GetClientModule(path);

        Assert.IsType<BadRequestResult>(result);
    }

    [Fact]
    public void UnknownAndWrongCaseModulesAreNotServed()
    {
        Assert.IsType<NotFoundResult>(CreateController().GetClientModule("missing.js"));
        Assert.IsType<NotFoundResult>(CreateController().GetClientModule("Utils/time.js"));
    }

    [Fact]
    public void ModuleResponseSetsSecurityAndCacheHeaders()
    {
        var controller = CreateController();

        var result = Assert.IsType<FileContentResult>(controller.GetClientModule("state.js"));

        Assert.Equal("text/javascript; charset=utf-8", result.ContentType);
        Assert.Equal("nosniff", controller.Response.Headers.XContentTypeOptions);
        Assert.Equal("public, max-age=3600", controller.Response.Headers.CacheControl);
        Assert.StartsWith("\"", controller.Response.Headers.ETag.ToString(), StringComparison.Ordinal);
        Assert.EndsWith("\"", controller.Response.Headers.ETag.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{etag}")]
    [InlineData("W/{etag}")]
    [InlineData("\"different\", {etag}")]
    [InlineData("*")]
    public void MatchingConditionalRequestReturnsNotModified(string headerTemplate)
    {
        var initialController = CreateController();
        Assert.IsType<FileContentResult>(initialController.GetClientModule("state.js"));
        var etag = initialController.Response.Headers.ETag.ToString();
        var controller = CreateController();
        controller.Request.Headers.IfNoneMatch = headerTemplate.Replace("{etag}", etag, StringComparison.Ordinal);

        var result = Assert.IsType<StatusCodeResult>(controller.GetClientModule("state.js"));

        Assert.Equal(StatusCodes.Status304NotModified, result.StatusCode);
        Assert.Equal(etag, controller.Response.Headers.ETag.ToString());
        Assert.Equal("public, max-age=3600", controller.Response.Headers.CacheControl);
    }

    [Fact]
    public void PublishedAssemblyContainsEveryDeclaredModule()
    {
        var projectDirectory = LocatePluginProject();
        var outputDirectory = Path.Combine(Path.GetTempPath(), $"owp-publish-{Guid.NewGuid():N}");

        try
        {
            var startInfo = new ProcessStartInfo("dotnet")
            {
                WorkingDirectory = projectDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add("publish");
            startInfo.ArgumentList.Add("OpenWatchPartyPlugin.csproj");
            startInfo.ArgumentList.Add("-c");
            startInfo.ArgumentList.Add("Release");
            startInfo.ArgumentList.Add("--no-restore");
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add(outputDirectory);

            using var process = Process.Start(startInfo);
            Assert.NotNull(process);
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.True(process.ExitCode == 0, $"dotnet publish failed:\n{stdout}\n{stderr}");

            var assemblyPath = Path.Combine(outputDirectory, "OpenWatchPartyPlugin.dll");
            Assert.True(File.Exists(assemblyPath));
            var context = new AssemblyLoadContext($"owp-artifact-{Guid.NewGuid():N}", isCollectible: true);
            try
            {
                var assembly = context.LoadFromAssemblyPath(assemblyPath);
                var resources = assembly.GetManifestResourceNames();
                foreach (var module in GetDeclaredModules(ReadCanonicalLoader()))
                {
                    Assert.Contains("OpenWatchParty.Plugin.Web." + module.Replace('/', '.'), resources);
                }
            }
            finally
            {
                context.Unload();
            }
        }
        finally
        {
            if (Directory.Exists(outputDirectory))
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
        }
    }

    private static OpenWatchPartyController CreateController()
    {
        return new OpenWatchPartyController(NullLogger<OpenWatchPartyController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext()
            }
        };
    }

    private static string ReadCanonicalLoader()
    {
        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("OpenWatchParty.Plugin.Tests.Fixtures.plugin.js");
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static IReadOnlyList<string> GetDeclaredModules(string loader)
    {
        return ModulePattern.Matches(loader)
            .Select(match => match.Groups["path"].Value)
            .ToArray();
    }

    private static string LocatePluginProject()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            var directProject = Path.Combine(current.FullName, "OpenWatchPartyPlugin.csproj");
            if (File.Exists(directProject))
            {
                return current.FullName;
            }

            var siblingProject = Path.Combine(current.FullName, "OpenWatchParty", "OpenWatchPartyPlugin.csproj");
            if (File.Exists(siblingProject))
            {
                return Path.GetDirectoryName(siblingProject)!;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate OpenWatchPartyPlugin.csproj");
    }
}
