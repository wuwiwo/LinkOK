# 0002 — Screenshot delivery model and clipboard semantics

## Status

Accepted

## Context

Screenshots and clipboard text both cross the LAN, and each has a decision that is expensive to reverse once the app is in daily use.

For screenshots:

- The PC has several ways to produce an image (the `PrtSc` key, `Win+Shift+S`, the Snipping Tool, browser "copy image"). Intercepting the key with a low-level keyboard hook would only cover the first, and would need its own capture path.
- The same screenshot can be observable twice: once as clipboard content and once as a new file in the screenshots folder.

For the clipboard:

- Android 10 and later only allow clipboard reads while the app is in the foreground or is the default input method.

## Decision

### Screenshots

The PC treats any image appearing on its clipboard as a Capture, plus any new file landing in the system screenshots folder. There is no keyboard hook and no synthetic capture. Duplicates are dropped by content hash. Phone Captures are written to the PC clipboard and also kept in PC-side History. PC Captures are delivered to the phone's Stash, where the user explicitly Saves them into the system gallery (`Pictures/LinkOK`) or Discards them; Save moves the image, leaving no copy in the Stash.

### Clipboard

Clipboard Sync carries plain text only, in both directions, last writer wins. LinkOK suppresses Echo: text it wrote itself is never treated as a user copy. The phone to PC direction is asymmetric by necessity: an `AccessibilityService` reads the clipboard in the background when the permission is granted, with a Quick Settings tile and the foreground app as fallbacks.

## Consequences

- "Copy image" and "screenshot" are deliberately the same thing. Copying an image on the PC sends it to the phone. This was accepted as the simpler and more useful behaviour.
- Because there is no keyboard hook, there is no double-send from a key press, and every screenshot tool is covered for free.
- The phone may receive an image the user did not consider a screenshot; Discard is one tap.
- The phone to PC clipboard path degrades to manual when MIUI kills the Accessibility Service. This is a known and accepted fragility, not a bug.
- Echo suppression is a correctness invariant, not a feature: without it, the two devices would overwrite each other's clipboards in a loop.
