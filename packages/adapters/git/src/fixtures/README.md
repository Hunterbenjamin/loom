# Git CLI fixture

`git-2.51.2.json` records Git 2.51.2 output from a disposable SHA-1 repository.
NULs, newlines, quotes and Unicode are preserved as JSON string escapes. It contains
no remote, identity, transcript or user repository data.

The base has a six-line file named `old"雪\n.txt` and a one-line `deleted.txt`.
The head renames the first file to `new"葉\n.txt`, replaces its third line, deletes
the second file, and adds an empty file and a three-byte binary (`01 00 02`).

Commands recorded:

- `git diff --raw --no-abbrev -z --find-renames <base> <head>`
- `git diff --numstat -z --find-renames <base> <head>`
- `git diff -U0 <old-blob> <new-blob>`
- `git status --porcelain=v1 -z --untracked-files=all` after another modification
  to the renamed file and addition of `untracked 雪`.

The integration tests build the same kinds of repositories afresh; the recorded
fixture independently exercises malformed/truncated boundary validation.
