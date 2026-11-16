# Sourced inside the disposable CI sandbox (container-suite.sh). Never run on
# the host. A corrupted npm cache is not trusted or repaired in place: the
# cache directory is discarded and the install is rebuilt once from a clean
# cache. Other install failures are returned unchanged and are not retried.

# Signatures of a damaged cache or a truncated download, not of test failures.
NPM_CACHE_CORRUPTION='EINTEGRITY|ECOMPROMISED|integrity checksum failed|TAR_BAD_ARCHIVE|TAR_ENTRY_INVALID|zlib: (unexpected end|invalid)|Unexpected end of JSON input|ENOENT[^ ]* .*_cacache'

npm_cache_corrupt() { grep -qE "$NPM_CACHE_CORRUPTION" "$1"; }

npm_ci_rebuild() {
  local cache=${npm_config_cache:-} log status=0
  case $cache in
    /?*/*) ;;
    *) echo 'npm_ci_rebuild needs an absolute npm_config_cache below a directory' >&2; return 2 ;;
  esac
  log=$(mktemp)
  npm ci "$@" 2>&1 | tee "$log" || status=$?
  if ((status == 0)); then rm -f "$log"; return 0; fi
  if ! npm_cache_corrupt "$log"; then rm -f "$log"; return "$status"; fi
  rm -f "$log"
  echo "npm cache corruption detected in $cache; rebuilding once from a clean cache" >&2
  rm -rf -- "$cache"
  mkdir -p -- "$cache"
  npm ci "$@"
}
