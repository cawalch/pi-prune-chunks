# Testing

Quality gate:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run check
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run pack:dry
```

The automated suite covers:

- collector classification and source inference
- stable registry IDs and metadata persistence without raw content
- pin, prune, restore, and audit state transitions
- tombstone rendering and non-mutating context replacement
- auto-prune preservation rules
- memory and source-range restore paths
- extension tool registration and context-hook auto-pruning

Manual dogfood should use a real Pi session with repeated searches, file reads,
test runs, and diffs. Confirm that old bulky tool outputs become tombstones in
provider context and that the saved transcript remains auditable.
