# 0003 — Pairing, discovery, and retention

## Status

Accepted

## Context

The PC's LAN address is assigned by DHCP and changes on reconnect and after router restarts. A phone that only ever knew `192.168.1.x:port` would break silently and force a re-pair.

The LAN is otherwise shared with other devices, so an unauthenticated endpoint would let anything on the network read the clipboard and push images onto the phone.

Retention ("clear old screenshots every 7/15/30 days") is ambiguous on two axes: which files it may delete, and what the age is measured from.

## Decision

### Pairing and discovery

Pairing happens once, by scanning a QR code the PC shows in the Tray menu or in the settings page. The code contains the PC's address and a short-lived Pairing Code. Scanning mints a long-lived Token that the phone presents on every request and that survives reboots. When the Link drops because the PC's address changed, the phone re-finds the Hub by UDP broadcast on the LAN; the Hub answers with its current address, and the Token keeps working.

### Retention

Retention applies only to copies LinkOK itself created, on both sides: the phone's Stash and the PC's History. It never deletes from the phone's system gallery or from the user's own screenshots folder. The user chooses 7, 15, 30 days or Never, defaulting to 30. Age is measured from Arrival Time, the moment the Capture entered LinkOK, not from the image's own timestamp.

## Consequences

- Nothing on the LAN can read or write LinkOK state without having physically scanned the QR code.
- The system stays usable across DHCP changes without re-pairing.
- The user's own screenshots library is out of reach of the cleanup job, so Retention can never destroy an image the user chose to Save.
- Daily cleanup must run on both sides against their own stores; a single sweep on the PC cannot delete phone-side files, and vice versa.
- Re-pairing is still available and revokes the old Token, which is the recovery path if the phone is lost or the Token leaks.
