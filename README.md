# mega-tail

Tail dynamic logs in a directory tree.

`mega-tail` follows appended lines across all matching log files under a root directory, and automatically starts following newly created log files as they appear.

## Features

- Recursive discovery under a root directory
- Live follow of existing files
- Auto-discovery of new files
- Per-line prefix with source file path and detection timestamp
- Handles truncation/rotation safely

## Usage

```bash
./mega-tail <directory>
```

Example:

```bash
./mega-tail /var/log/myapp
```

Sample output:

```text
[subdir1/somelog.log] [2026-02-05 16:09:07.333] 2026-02-02: 12:23:23.123 [DEBUG] my log message....
[subdir2/somelog2.log] [2026-02-05 16:09:07.337] 2026-02-02: 12:23:23.223 [DEBUG] my otherlog message....
```

## Options

```bash
./mega-tail --help
```

Key options:

- `--glob <pattern>`: Add include glob (repeatable)
- `--poll-interval <seconds>`: Read loop interval
- `--scan-interval <seconds>`: New-file scan interval
- `-n, --initial-lines <N>`: Show last N lines on startup
- `--color auto|always|never`: Color mode
