#!/bin/sh
# Stub command for testing: echoes every line of stdin back to stdout.
# Acts as a pseudo-interactive shell so PtyManager can detect output (→ ready)
# and verify that input is forwarded through the PTY.
#
# Prints a startup banner so PtyManager transitions to ready immediately.
printf 'STUB_READY\r\n'
while IFS= read -r line; do
  printf '%s\r\n' "$line"
done
