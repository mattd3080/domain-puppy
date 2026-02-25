#!/bin/sh
# Domain Puppy — version bump script
# Updates the version in ALL locations within SKILL.md.
#
# Usage: ./hooks/bump-version.sh 1.6.0

set -e

NEW_VERSION="$1"

if [ -z "$NEW_VERSION" ]; then
  echo "Usage: ./hooks/bump-version.sh <new-version>"
  echo "Example: ./hooks/bump-version.sh 1.6.0"
  exit 1
fi

if ! printf '%s' "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: Version must be semver (e.g., 1.6.0)"
  exit 1
fi

SKILL="SKILL.md"

if [ ! -f "$SKILL" ]; then
  echo "ERROR: $SKILL not found. Run this from the repo root."
  exit 1
fi

# Get current version from frontmatter
OLD_VERSION=$(grep '^version:' "$SKILL" | head -1 | awk '{print $2}')

if [ -z "$OLD_VERSION" ]; then
  echo "ERROR: Could not find current version in $SKILL"
  exit 1
fi

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "Already at version $NEW_VERSION"
  exit 0
fi

# Replace all version occurrences
# 1. Frontmatter: version: X.Y.Z
sed -i '' "s/^version: ${OLD_VERSION}/version: ${NEW_VERSION}/" "$SKILL"

# 2. LOCAL_VERSION="X.Y.Z"
sed -i '' "s/LOCAL_VERSION=\"${OLD_VERSION}\"/LOCAL_VERSION=\"${NEW_VERSION}\"/g" "$SKILL"

# 3. Comment headers: (vX.Y.Z)
sed -i '' "s/(v${OLD_VERSION})/(v${NEW_VERSION})/g" "$SKILL"

# Verify
FRONT=$(grep '^version:' "$SKILL" | head -1 | awk '{print $2}')
LOCAL=$(grep 'LOCAL_VERSION=' "$SKILL" | head -1 | sed 's/.*LOCAL_VERSION="\([^"]*\)".*/\1/')

if [ "$FRONT" != "$NEW_VERSION" ] || [ "$LOCAL" != "$NEW_VERSION" ]; then
  echo "ERROR: Version mismatch after update. Check SKILL.md manually."
  echo "  frontmatter: $FRONT"
  echo "  LOCAL_VERSION: $LOCAL"
  exit 1
fi

echo "Bumped $OLD_VERSION -> $NEW_VERSION"
echo "  frontmatter:    $NEW_VERSION"
echo "  LOCAL_VERSION:   $NEW_VERSION"
echo "  comment headers: $NEW_VERSION"
echo ""
echo "Next: git add SKILL.md && git commit"
