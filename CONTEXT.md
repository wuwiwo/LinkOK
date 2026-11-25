# LinkOK

Local-network clipboard and screenshot bridge between one Android phone and one Windows PC. Personal use, single user, no cloud.

## Language

### Devices & Roles

**Phone**:
The single Android device (Xiaomi M2012K11AC, Android 13) running the LinkOK app.
_Avoid_: Mobile, client, mobile client, device

**PC**:
The single Windows 11 machine running the LinkOK background service.
_Avoid_: Desktop, server, host, master

**Hub**:
The PC-side process that owns the canonical state and accepts connections from the Phone.
_Avoid_: Server, backend, daemon

### Screenshots

**Capture**:
One image the user produced on either device that LinkOK delivers as a screenshot item. A Capture's sources are the Phone's screenshot folder, the PC's screenshot folder, and any image that appears on the PC clipboard. Captures made by copying an image count the same as Captures made by a screenshot key.
_Avoid_: Screenshot file, shot, snap, image, copy

**Phone Capture**:
A Capture produced by the Phone and delivered to the PC's clipboard.
_Avoid_: Upload, inbound shot

**PC Capture**:
A Capture produced by the PC and delivered to the Phone's stash.
_Avoid_: Download, outbound shot

**Duplicate**:
A Capture whose image content is byte-identical to a Capture that was already delivered. Duplicates are dropped, never delivered twice.
_Avoid_: Repeat, resend, double

**Arrival Time**:
The moment a Capture entered LinkOK. Retention is measured from Arrival Time, not from the image's own creation or modification timestamp.
_Avoid_: Capture time, photo date, modified time

**Retention**:
The user-chosen age limit after which LinkOK deletes its own copies of Captures. The choices are 7, 15, 30 days or Never; the default is 30 days. Retention never touches the phone's system gallery or any file LinkOK did not create.
_Avoid_: Cleanup, expiry, cache clear, auto-delete

**Stash**:
The Phone-side holding area where PC Captures wait until the user saves or discards them. The Stash is not the phone's photo gallery.
_Avoid_: Inbox, temp folder, buffer, 暂存区 (as a code identifier)

**History**:
The PC-side archive of Captures that LinkOK itself wrote, used for the settings page and for re-sending. History is subject to Retention, and is distinct from the user's own screenshots folder.
_Avoid_: Log, cache, archive, backup

**Save**:
The user action that moves a Capture out of the Stash and into the phone's system photo gallery.
_Avoid_: Export, download, keep

**Discard**:
The user action that removes a Capture from the Stash without saving it.
_Avoid_: Delete, trash, remove

**Tray**:
The PC-side icon that shows whether the Link is up and carries the menu for pairing, opening settings, pausing, and quitting.
_Avoid_: Tray agent, systray, taskbar icon

### Pairing

**Pairing**:
The one-time act of binding the Phone to the PC by scanning a QR code shown on the PC. Pairing yields a long-lived Token.
_Avoid_: Login, sign-in, setup, connect

**Token**:
The long-lived secret a paired Phone presents on every request. It survives reboots and network changes.
_Avoid_: Password, API key, session, cookie

**Pairing Code**:
The short-lived value embedded in the QR code, used once to mint a Token.
_Avoid_: QR password, PIN

**Link**:
The live connection between Phone and Hub over which Captures and Clipboard Sync travel. A Link is either up or down; the Phone re-establishes it automatically.
_Avoid_: Session, socket, channel, tunnel

**Echo**:
A clipboard write that LinkOK performed itself and must therefore never treat as a user copy.
_Avoid_: Loop, bounce, feedback

### Clipboard

**Clipboard Sync**:
The two-way exchange of plain-text clipboard content between Phone and PC. It is asymmetric: PC to Phone is always automatic, while Phone to PC runs through an Accessibility Service when granted and falls back to a Quick Settings tile or the app in the foreground. Images never travel through Clipboard Sync; they travel as Captures.
_Avoid_: Clipboard share, copy sync, paste sync
