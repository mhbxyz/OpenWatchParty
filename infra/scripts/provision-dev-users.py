#!/usr/bin/env python3
"""Create the documented Jellyfin users for the disposable local dev stack."""

import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = f"http://localhost:{os.environ.get('JELLYFIN_PORT', '8096')}"
PASSWORD = os.environ.get("OWP_DEV_PASSWORD", "owp-dev-test")
USERS = ("testhost", "testclient1", "testclient2")
PLUGIN_ID = "0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d"
LIBRARY_NAME = "Blender Open Movies (Dev)"
LIBRARY_PATH = "/media/DevMovies"
CLIENT = 'MediaBrowser Client="OpenWatchParty dev setup", Device="localhost", DeviceId="owp-dev-setup", Version="1.0"'


def request(path, data=None, token=None):
    headers = {"Authorization": CLIENT + (f', Token="{token}"' if token else "")}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(
        BASE_URL + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    with urlopen(req, timeout=10) as response:
        body = response.read()
        return json.loads(body) if body else None


def retry_request(path, data=None, token=None, attempts=30, delay=2):
    """Retry transient 404/503 while Jellyfin finishes starting its subsystems."""
    for attempt in range(attempts):
        try:
            return request(path, data=data, token=token)
        except HTTPError as exc:
            if exc.code not in (404, 503) or attempt == attempts - 1:
                raise
            time.sleep(delay)
    raise RuntimeError(f"Unreachable: {path}")


def session_server_health(timeout=30):
    """Fail before the tests start when the session server never comes up."""
    url = f"http://localhost:{os.environ.get('SESSION_SERVER_PORT', '3000')}/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                return json.loads(response.read())
        except (URLError, ConnectionError, TimeoutError):
            time.sleep(1)
    raise RuntimeError(f"Session server is not answering {url}; check docker logs owp-session-server")


def main():
    if not PASSWORD:
        raise RuntimeError("OWP_DEV_PASSWORD must not be empty")

    info = None
    for attempt in range(60):
        try:
            info = request("/System/Info/Public")
            # A fresh Jellyfin can answer 200 with an empty payload while it
            # starts; wait until the startup state is actually reported.
            if "StartupWizardCompleted" in info:
                break
        except HTTPError as exc:
            if exc.code not in (404, 503):
                raise
        except (OSError, ValueError):
            pass
        if attempt == 59:
            raise RuntimeError("Jellyfin did not become ready within 120 seconds")
        time.sleep(2)

    if not info["StartupWizardCompleted"]:
        # Jellyfin creates the default first user when the wizard user step is
        # read; POST then renames it and sets the password (same as the web wizard).
        retry_request("/Startup/User")
        retry_request("/Startup/User", {"Name": USERS[0], "Password": PASSWORD})
        retry_request("/Startup/Complete", {})
        print("Initialized Jellyfin dev admin: testhost")

    try:
        auth = retry_request("/Users/AuthenticateByName", {"Username": USERS[0], "Pw": PASSWORD})
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise RuntimeError(
                "Cannot authenticate testhost. This Jellyfin configuration already has "
                "different credentials; use a fresh dev configuration or restore its password."
            ) from None
        raise

    token = auth["AccessToken"]
    users = {user["Name"].casefold() for user in request("/Users", token=token)}
    for name in USERS[1:]:
        if name.casefold() in users:
            print(f"Existing Jellyfin dev user: {name}")
            continue
        request("/Users/New", {"Name": name, "Password": PASSWORD}, token=token)
        print(f"Created Jellyfin dev user: {name}")

    config_path = f"/Plugins/{PLUGIN_ID}/Configuration"
    config = retry_request(config_path, token=token)
    secret = os.environ.get("JWT_SECRET", "")
    desired = {
        "JwtSecret": secret,
        "AllowInsecureNoAuth": not bool(secret),
        "SessionServerUrl": f"ws://localhost:{os.environ.get('SESSION_SERVER_PORT', '3000')}/ws",
    }
    if any(config.get(key) != value for key, value in desired.items()):
        config.update(desired)
        retry_request(config_path, config, token=token)
        print("Configured OpenWatchParty for the local session server")
    plugin_token = retry_request("/OpenWatchParty/Token", token=token)
    if plugin_token["auth_enabled"] != bool(secret):
        raise RuntimeError("Plugin and session server authentication modes do not match")
    if session_server_health()["auth_enabled"] != bool(secret):
        raise RuntimeError("Session server authentication mode does not match JWT_SECRET")

    folders = retry_request("/Library/VirtualFolders", token=token)
    for folder in folders:
        if folder["Name"] == LIBRARY_NAME:
            if LIBRARY_PATH not in folder.get("Locations", []):
                raise RuntimeError(f"{LIBRARY_NAME} exists with a different media path")
            print(f"Existing Jellyfin dev library: {LIBRARY_NAME}")
            break
    else:
        if any(LIBRARY_PATH in folder.get("Locations", []) for folder in folders):
            raise RuntimeError(f"{LIBRARY_PATH} already belongs to another library")
        query = urlencode({"name": LIBRARY_NAME, "collectionType": "movies", "paths": LIBRARY_PATH})
        retry_request(
            f"/Library/VirtualFolders?{query}",
            {"LibraryOptions": {"PathInfos": [{"Path": LIBRARY_PATH}], "EnableInternetProviders": False}},
            token=token,
        )
        print(f"Created Jellyfin dev library: {LIBRARY_NAME} ({LIBRARY_PATH})")
        request("/Library/Refresh", {}, token=token)
        for _ in range(45):
            media_folders = request("/Library/MediaFolders", token=token)["Items"]
            folder = next((item for item in media_folders if item["Name"] == LIBRARY_NAME), None)
            if folder is None:
                time.sleep(2)
                continue
            items = request(
                f"/Users/{auth['User']['Id']}/Items?ParentId={folder['Id']}&Recursive=true&IncludeItemTypes=Movie",
                token=token,
            )["Items"]
            if {item["Name"] for item in items} >= {"Wing It!", "Sprite Fright"}:
                print("Jellyfin dev movies indexed: Wing It!, Sprite Fright")
                break
            time.sleep(2)
        else:
            raise RuntimeError("Jellyfin did not index both dev movies within 90 seconds")
    print("Jellyfin dev users ready: " + ", ".join(USERS))


if __name__ == "__main__":
    try:
        main()
    except (HTTPError, URLError, KeyError, ValueError, RuntimeError) as exc:
        location = f" ({exc.url})" if isinstance(exc, HTTPError) else ""
        print(f"Dev user provisioning failed: {exc}{location}", file=sys.stderr)
        sys.exit(1)
