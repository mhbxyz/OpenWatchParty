# User Guide

## Installation

### 1. Server Plugin

1.  Download the latest release of the OpenSyncParty plugin (DLL file).
2.  Copy the `OpenSyncParty.dll` and its dependencies to your Jellyfin plugins directory (e.g., `/var/lib/jellyfin/plugins/OpenSyncParty`).
3.  Restart your Jellyfin server.

### 2. Client Activation (Important!)

Since Jellyfin 10.9+, plugins cannot automatically inject scripts into the web interface for security reasons. You must enable the OpenSyncParty client script manually.

1.  Go to the **Jellyfin Dashboard**.
2.  Navigate to **General** settings.
3.  Scroll down to the **Custom HTML** (or Branding) section.
4.  Paste the following line into the "Custom HTML body" field:
    ```html
    <script src="/OpenSyncParty/ClientScript"></script>
    ```
5.  Click **Save**.
6.  Refresh your browser (Ctrl+F5) to load the changes.

## Configuration

1.  Go to **Dashboard > Plugins > OpenSyncParty**.
2.  Configure the **JWT Secret** (optional but recommended for security).
3.  Click **Save**.

## Usage

1.  Start playing a video.
2.  Look for the "Watch Party" group icon in the top header bar (right side).
3.  Click it to open the party panel.
4.  **Host**: Click "Start Room".
5.  **Join**: Enter the Room ID provided by the host and click "Join".