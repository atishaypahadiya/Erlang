#!/usr/bin/env bash
# Run once after cloning. Points git at the repository's hooks, so the
# authorship hygiene check runs on every commit, and links the terms file the
# check reads to the file the specialists share on this machine:
#
#   ~/.config/specialists/private-terms
#
# If the shared file exists, .erlang-private-terms becomes a link to it. If it
# does not, setup creates it empty, links to it and warns: the check has
# nothing to look for until patterns are added (see scripts/hygiene.sh). The
# shared file lives outside the repository and is never committed; the link is
# ignored by git, and the hygiene check refuses to commit it.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

git config core.hooksPath scripts/hooks
chmod +x scripts/hygiene.sh scripts/hooks/*
echo "setup: hooks enabled (core.hooksPath = scripts/hooks)"

shared_dir="$HOME/.config/specialists"
shared="$shared_dir/private-terms"
terms=".erlang-private-terms"

if [[ -f $shared ]]; then
  echo "setup: using the shared terms file $shared"
else
  mkdir -p "$shared_dir"
  chmod 700 "$shared_dir"
  (umask 077 && : > "$shared")
  echo "setup: warning: $shared did not exist; created it empty. Add one pattern per line, or the hygiene check has nothing to look for." >&2
fi

# Replace whatever is at $terms with a link to the shared file. A link is
# replaced silently; a regular file with content is kept beside it, since it
# may hold patterns the shared file lacks.
if [[ -L $terms ]]; then
  if [[ $(readlink "$terms") == "$shared" ]]; then
    echo "setup: $terms already links to $shared"
  else
    old=$(readlink "$terms")
    ln -sfn "$shared" "$terms"
    echo "setup: $terms now links to $shared (it linked to $old before)"
  fi
elif [[ -e $terms ]]; then
  if [[ -s $terms ]]; then
    backup="$terms.local"
    mv "$terms" "$backup"
    echo "setup: warning: moved the existing $terms to $backup; copy any patterns it holds into $shared, then delete it." >&2
  else
    rm "$terms"
  fi
  ln -s "$shared" "$terms"
  echo "setup: $terms now links to $shared"
else
  ln -s "$shared" "$terms"
  echo "setup: $terms now links to $shared"
fi

for path in "$terms" "$terms.local"; do
  if ! git check-ignore -q "$path"; then
    echo "setup: $path is not ignored by git; add it to .gitignore before committing" >&2
    exit 1
  fi
done
