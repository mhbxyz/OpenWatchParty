"""Regressions for drift between independently edited client contracts."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "verify-client-contract.py"
spec = importlib.util.spec_from_file_location("client_contract", SCRIPT)
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


class ClientContractTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sources = {
            contract.CLIENT / "plugin.js": "await load('state.js');\nawait load('utils/time.js');\n",
            contract.CLIENT / "state.js": "const state = { PROTOCOL_VERSION: 1, };\n",
            contract.CLIENT / "utils/time.js": "const time = {};\n",
            contract.JUST: 'client_js_files := "state.js utils/time.js"\n',
            contract.CONTROLLER: 'internal const int ProtocolVersion = 1;\n'
                                 'AllowedClientModules = new HashSet<string>(StringComparer.Ordinal)\n'
                                 '{ "state.js", "utils/time.js" };\n',
            contract.RUST: 'pub(crate) const PROTOCOL_VERSION: u64 = 1;\n',
        }
        for path, text in self.sources.items():
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def replace(self, path, before, after):
        target = self.root / path
        target.write_text(target.read_text(encoding="utf-8").replace(before, after), encoding="utf-8")

    def test_valid_contract_and_unordered_allowlist(self):
        self.assertEqual(contract.verify(self.root), (2, 1))
        self.replace(contract.CONTROLLER, '"state.js", "utils/time.js"', '"utils/time.js", "state.js"')
        self.assertEqual(contract.verify(self.root), (2, 1))

    def test_one_protocol_copy_drifting_fails(self):
        for path, before in ((contract.CLIENT / "state.js", "PROTOCOL_VERSION: 1"),
                             (contract.RUST, "u64 = 1"),
                             (contract.CONTROLLER, "ProtocolVersion = 1")):
            with self.subTest(path=path):
                self.replace(path, before, before.replace("1", "2"))
                with self.assertRaisesRegex(ValueError, "protocol version mismatch"):
                    contract.verify(self.root)
                (self.root / path).write_text(self.sources[path], encoding="utf-8")

    def test_consistent_protocol_bump_is_allowed(self):
        for path in (contract.CLIENT / "state.js", contract.RUST, contract.CONTROLLER):
            self.replace(path, "1", "2")
        self.assertEqual(contract.verify(self.root), (2, 2))

    def test_missing_protocol_declaration_fails(self):
        self.replace(contract.RUST, "PROTOCOL_VERSION", "RENAMED_PROTOCOL")
        with self.assertRaisesRegex(ValueError, "Rust protocol: expected one literal declaration"):
            contract.verify(self.root)

    def test_missing_module_in_each_list_fails(self):
        for path, before in ((contract.CLIENT / "plugin.js", "await load('utils/time.js');\n"),
                             (contract.JUST, " utils/time.js"),
                             (contract.CONTROLLER, ', "utils/time.js"')):
            with self.subTest(path=path):
                self.replace(path, before, "")
                with self.assertRaisesRegex(ValueError, "module mismatch"):
                    contract.verify(self.root)
                (self.root / path).write_text(self.sources[path], encoding="utf-8")

    def test_duplicate_module_in_each_list_fails(self):
        for path, before, after in (
            (contract.CLIENT / "plugin.js", "await load('state.js');", "await load('state.js');\nawait load('state.js');"),
            (contract.JUST, '"state.js ', '"state.js state.js '),
            (contract.CONTROLLER, '"state.js",', '"state.js", "state.js",'),
        ):
            with self.subTest(path=path):
                self.replace(path, before, after)
                with self.assertRaisesRegex(ValueError, "duplicate modules: state.js"):
                    contract.verify(self.root)
                (self.root / path).write_text(self.sources[path], encoding="utf-8")

    def test_missing_and_empty_source_fail(self):
        source = self.root / contract.CLIENT / "utils/time.js"
        source.unlink()
        with self.assertRaisesRegex(ValueError, "missing or empty client module"):
            contract.verify(self.root)
        source.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "missing or empty client module"):
            contract.verify(self.root)

    def test_every_just_file_declaration_must_match(self):
        for path in (Path("justfile"), Path("infra/just/build.just")):
            with self.subTest(path=path):
                target = self.root / path
                target.write_text('set quiet\nclient_js_files := "state.js utils/time.js"\n', encoding="utf-8")
                self.assertEqual(contract.verify(self.root), (2, 1))
                self.replace(path, " utils/time.js", "")
                with self.assertRaisesRegex(ValueError, f"^{path.as_posix()}: module mismatch"):
                    contract.verify(self.root)
                target.unlink()

    def test_exported_declaration_is_checked(self):
        (self.root / "justfile").write_text('export client_js_files := "state.js"\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "^justfile: module mismatch"):
            contract.verify(self.root)

    def test_just_files_without_the_list_are_ignored(self):
        for path in (Path("justfile"), Path("infra/just/lint.just")):
            (self.root / path).write_text('import "common.just"\nlint:\n    true\n', encoding="utf-8")
        self.assertEqual(contract.verify(self.root), (2, 1))

    def test_other_just_declarations_must_be_single_literals(self):
        target = self.root / "justfile"
        for text, message in (
            ('client_js_files := "state.js" + " utils/time.js"\n', "justfile: expected one literal declaration, found 0"),
            ('client_js_files := "state.js utils/time.js"\nclient_js_files := "state.js utils/time.js"\n',
             "justfile: expected one literal declaration, found 2"),
            ('client_js_files := "state.js utils/time.js"\nclient_js_files := other\n',
             "justfile: expected one literal declaration, found 2"),
        ):
            with self.subTest(text=text):
                target.write_text(text, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, message):
                    contract.verify(self.root)

    def test_missing_common_just_declaration_fails(self):
        (self.root / contract.JUST).unlink()
        (self.root / "justfile").write_text('client_js_files := "state.js utils/time.js"\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "common.just: expected one literal declaration, found 0"):
            contract.verify(self.root)

    def test_commented_declarations_are_not_contracts(self):
        self.replace(contract.CLIENT / "plugin.js", "await load('state.js');",
                     "// load('unused.js');\n/* load('state.js'); */\nawait load('state.js');")
        self.replace(contract.RUST, "pub(crate)", "// const PROTOCOL_VERSION: u64 = 9;\npub(crate)")
        self.assertEqual(contract.verify(self.root), (2, 1))

    def test_dynamic_loader_call_is_rejected(self):
        self.replace(contract.CLIENT / "plugin.js", "'utils/time.js'", "moduleName")
        with self.assertRaisesRegex(ValueError, "requires a literal module path"):
            contract.verify(self.root)

    def test_allowlist_expression_is_rejected(self):
        self.replace(contract.CONTROLLER, '"utils/time.js"', '"utils/" + "time.js"')
        with self.assertRaisesRegex(ValueError, "expected literal module paths"):
            contract.verify(self.root)

    def test_path_traversal_is_rejected(self):
        self.replace(contract.CLIENT / "plugin.js", "utils/time.js", "../time.js")
        with self.assertRaisesRegex(ValueError, "invalid module path"):
            contract.verify(self.root)

    def test_cli_reports_success_and_actionable_failure(self):
        command = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 modules; protocol version 1", result.stdout)
        self.replace(contract.JUST, " utils/time.js", "")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("common.just: module mismatch", result.stderr)
        self.assertIn("utils/time.js", result.stderr)


if __name__ == "__main__":
    unittest.main()
