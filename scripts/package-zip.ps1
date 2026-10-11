param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
function Get-PackageSha256([string]$File) {
  $packageHashStream = [System.IO.File]::OpenRead($File)
  $packageHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($packageHashAlgorithm.ComputeHash($packageHashStream)).Replace('-', '') }
  finally { $packageHashStream.Dispose(); $packageHashAlgorithm.Dispose() }
}
$packageSource = (Resolve-Path -LiteralPath $Source).ProviderPath
$packageDestination = [System.IO.Path]::GetFullPath($Destination)
$packageParent = [System.IO.Directory]::GetParent($packageSource).FullName
if ([System.IO.Path]::GetDirectoryName($packageDestination) -ne $packageParent) {
  throw 'The zip must be written alongside the portable app directory.'
}
if ([System.IO.File]::Exists($packageDestination)) { [System.IO.File]::Delete($packageDestination) }
$packageFiles = @(Get-ChildItem -LiteralPath $packageSource -Recurse -File)
$packagePrefix = [System.IO.Path]::GetFileName($packageSource) + '/'
$packageWriter = [System.IO.Compression.ZipFile]::Open($packageDestination, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($packageFile in $packageFiles) {
    $packageRelative = $packageFile.FullName.Substring($packageSource.Length + 1).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($packageWriter, $packageFile.FullName, $packagePrefix + $packageRelative, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $packageWriter.Dispose() }
$packageArchive = [System.IO.Compression.ZipFile]::OpenRead($packageDestination)
try {
  $packageEntries = @($packageArchive.Entries | Where-Object { $_.Name -ne '' })
  if ($packageEntries.Count -ne $packageFiles.Count) { throw 'Zip inventory differs from the portable directory.' }
  foreach ($packageFile in $packageFiles) {
    $packageRelative = $packageFile.FullName.Substring($packageSource.Length + 1).Replace([System.IO.Path]::DirectorySeparatorChar, [char]'/')
    $packageEntry = $packageArchive.GetEntry($packagePrefix + $packageRelative)
    if ($null -eq $packageEntry -or $packageEntry.Length -ne $packageFile.Length) { throw "Zip length mismatch: $packageRelative" }
  }
  $packageExe = $packageArchive.GetEntry($packagePrefix + 'EasyWorkflow.exe')
  if ($null -eq $packageExe) { throw 'EasyWorkflow.exe is absent from the zip.' }
  $packageHasher = [System.Security.Cryptography.SHA256]::Create()
  $packageStream = $packageExe.Open()
  try { $packageZipExeHash = [System.BitConverter]::ToString($packageHasher.ComputeHash($packageStream)).Replace('-', '') }
  finally { $packageStream.Dispose(); $packageHasher.Dispose() }
  $packageSourceHash = Get-PackageSha256 (Join-Path $packageSource 'EasyWorkflow.exe')
  if ($packageZipExeHash -ne $packageSourceHash) { throw 'The executable changed while compressing.' }
} finally { $packageArchive.Dispose() }
$packageZip = Get-Item -LiteralPath $packageDestination
@{ path = $packageDestination; bytes = $packageZip.Length; files = $packageFiles.Count; sha256 = (Get-PackageSha256 $packageDestination); verified = $true } | ConvertTo-Json -Compress
