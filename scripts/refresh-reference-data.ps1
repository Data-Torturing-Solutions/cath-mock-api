<#
.SYNOPSIS
    Re-vendors the CaTH reference data from HMCTS source.

.DESCRIPTION
    Schema drift is the top risk on this integration: HMCTS add list types and
    change schemas without notice, and the spec says so explicitly. Nothing
    here is hand-maintained -- this script regenerates all of it:

      vendor/list-types.json   <- pip-data-models/ListType.java
      vendor/schemas/*.json    <- pip-data-management/src/main/resources/schemas
      vendor/venues.json       <- Find a Court or Tribunal   (with -Venues)
      src/shared/generator/schemas.ts (generated barrel + list-type mapping)

    Run it monthly. If the test suite goes red afterwards, HMCTS changed
    something and you need to know before CaTH starts pushing it at you.

.PARAMETER MirrorDir
    Where the git mirrors live. Reused if already cloned, created otherwise.

.PARAMETER Venues
    Also re-sweep Find a Court or Tribunal for venues. Off by default: it makes
    several hundred requests to a live public service and the venue list moves
    far more slowly than the schemas.

.EXAMPLE
    npm run refresh
.EXAMPLE
    powershell -File ./scripts/refresh-reference-data.ps1 -MirrorDir D:\hmcts\mirrors -Venues
#>
[CmdletBinding()]
param(
    [string] $MirrorDir = 'D:\hmcts\mirrors',
    [switch] $Venues
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is not on PATH. Install Git for Windows: https://git-scm.com/download/win'
}

$repos = @(
    @{ Name = 'pip-data-models';     Url = 'https://github.com/hmcts/pip-data-models.git' }
    @{ Name = 'pip-data-management'; Url = 'https://github.com/hmcts/pip-data-management.git' }
)

New-Item -ItemType Directory -Force -Path $MirrorDir | Out-Null

foreach ($repo in $repos) {
    $dir = Join-Path $MirrorDir "$($repo.Name).git"
    if (Test-Path $dir) {
        Write-Host "updating mirror $($repo.Name)..." -ForegroundColor Cyan
        git --git-dir=$dir remote update --prune | Out-Null
    }
    else {
        Write-Host "cloning mirror $($repo.Name)..." -ForegroundColor Cyan
        git clone --mirror --quiet $repo.Url $dir
    }
}

$modelsDir     = Join-Path $MirrorDir 'pip-data-models.git'
$managementDir = Join-Path $MirrorDir 'pip-data-management.git'

# --- list types -----------------------------------------------------------

$listTypeJava = Join-Path $env:TEMP 'ListType.java'
$listTypePath = 'src/main/java/uk/gov/hmcts/reform/pip/model/publication/ListType.java'
git --git-dir=$modelsDir show "master:$listTypePath" |
    Out-File -FilePath $listTypeJava -Encoding utf8

node (Join-Path $PSScriptRoot 'extract-list-types.mjs') `
     $listTypeJava `
     (Join-Path $repoRoot 'vendor/list-types.json')

Remove-Item $listTypeJava -ErrorAction SilentlyContinue

# --- schemas --------------------------------------------------------------

$schemaDir = Join-Path $repoRoot 'vendor/schemas'
New-Item -ItemType Directory -Force -Path $schemaDir | Out-Null

# Start from a clean directory so a schema HMCTS *removed* disappears here too.
Get-ChildItem -Path $schemaDir -Filter '*.json' | Remove-Item -Force

$schemaPaths = git --git-dir=$managementDir ls-tree -r --name-only master |
    Where-Object { $_ -like '*resources/schemas/*' -and $_ -like '*.json' }

foreach ($path in $schemaPaths) {
    $name = Split-Path $path -Leaf
    # The upstream tree has a non-strategic/ subdirectory; flatten it with a
    # prefix rather than nesting, so the generated barrel stays flat.
    if ((Split-Path $path -Parent) -like '*non-strategic') {
        $name = "non-strategic__$name"
    }
    git --git-dir=$managementDir show "master:$path" |
        Out-File -FilePath (Join-Path $schemaDir $name) -Encoding utf8
}

Write-Host ("vendored {0} schemas" -f $schemaPaths.Count) -ForegroundColor Green

# --- venues (optional) ----------------------------------------------------

if ($Venues) {
    node (Join-Path $PSScriptRoot 'fetch-venues.mjs') (Join-Path $repoRoot 'vendor/venues.json')
}

# --- regenerate the barrel ------------------------------------------------

node (Join-Path $PSScriptRoot 'build-schema-index.mjs')

Write-Host ''
Write-Host 'Reference data refreshed. Now run `npm test`.' -ForegroundColor Green
Write-Host 'A newly failing test means HMCTS changed something -- read it, do not silence it.' -ForegroundColor Yellow
