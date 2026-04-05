---
"json-patch-to-crdt": patch
---

Fix kind-mismatch merge resolution so it considers the newest dot anywhere in the
competing subtrees instead of only shallow container metadata.

This preserves causally newer deep edits when they race with a concurrent
replacement of the parent path by a different node kind, and adds a regression
test covering the nested `/k/a/b` reproduction from Issue #122.
