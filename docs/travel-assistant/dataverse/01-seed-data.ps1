#requires -Version 7.0
<#
.SYNOPSIS
  Seeds the TravelAssistant solution with cities, hotels, rooms, and guests
  from the CSV files in this folder.

.PREREQUISITES
  - 00-provision-solution.ps1 has been run successfully
  - Azure CLI installed and `az login` done
  - CSV files in the same folder as this script:
      seed-cities.csv, seed-hotels.csv, seed-rooms.csv, seed-guests.csv

.USAGE
  pwsh ./01-seed-data.ps1 -EnvironmentUrl https://myorg.crm4.dynamics.com

.NOTES
  Idempotent: if a row with the same primary key (name/slug/email) already
  exists, the script updates it instead of duplicating.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$EnvironmentUrl,

  [string]$Prefix     = 'tra',
  [string]$ApiVersion = 'v9.2',
  [string]$ScriptDir  = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$EnvironmentUrl = $EnvironmentUrl.TrimEnd('/')
$ApiBase = "$EnvironmentUrl/api/data/$ApiVersion"

# ---------------------------------------------------------------------------
# AUTH
# ---------------------------------------------------------------------------

Write-Host "→ Acquiring access token via Azure CLI…" -ForegroundColor Cyan
$tokenJson = az account get-access-token --resource $EnvironmentUrl --output json 2>$null
if (-not $tokenJson) {
  Write-Error "Couldn't get a token. Run 'az login' first."
  exit 1
}
$AccessToken = ($tokenJson | ConvertFrom-Json).accessToken

$Headers = @{
  Authorization      = "Bearer $AccessToken"
  Accept             = 'application/json'
  'OData-MaxVersion' = '4.0'
  'OData-Version'    = '4.0'
  'Content-Type'     = 'application/json; charset=utf-8'
  Prefer             = 'return=representation'
}

# ---------------------------------------------------------------------------
# REST HELPERS
# ---------------------------------------------------------------------------

function Invoke-Dataverse {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null
  )
  $url = "$ApiBase/$Path"
  $params = @{
    Method  = $Method
    Uri     = $url
    Headers = $Headers
  }
  if ($Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }

  try {
    return Invoke-RestMethod @params
  } catch {
    $resp = $_.Exception.Response
    $body = ''
    if ($resp) {
      try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {}
    }
    Write-Host "  ✗ $Method $url" -ForegroundColor Red
    if ($body) { Write-Host "    $body" -ForegroundColor DarkRed }
    throw
  }
}

function Get-Existing {
  param([string]$EntitySet, [string]$Filter, [string]$Select)
  $path = "$EntitySet`?`$filter=$Filter&`$select=$Select"
  return (Invoke-Dataverse -Method GET -Path $path).value
}

function Upsert-Row {
  param(
    [string]$EntitySet,
    [string]$IdField,
    [string]$MatchFilter,
    [hashtable]$Data,
    [string]$DisplayName
  )

  # Check if a row matching the filter already exists.
  $existing = Get-Existing -EntitySet $EntitySet -Filter $MatchFilter -Select $IdField
  if ($existing -and $existing.Count -gt 0) {
    $id = $existing[0].$IdField
    Invoke-Dataverse -Method PATCH -Path "$EntitySet($id)" -Body $Data | Out-Null
    Write-Host "    ↺ updated $DisplayName" -ForegroundColor DarkGray
    return $id
  }

  $created = Invoke-Dataverse -Method POST -Path $EntitySet -Body $Data
  $id = $created.$IdField
  Write-Host "    + created $DisplayName" -ForegroundColor DarkGreen
  return $id
}

# ---------------------------------------------------------------------------
# LOAD CSVs (handle the leading "# Cities" comment line on cities CSV)
# ---------------------------------------------------------------------------

function Import-CleanCsv {
  param([string]$Path)
  $lines = Get-Content -Path $Path -Encoding UTF8
  # Drop any leading comment lines starting with '#'
  $cleaned = @($lines | Where-Object { $_ -notmatch '^\s*#' -and $_ -ne '' })
  return $cleaned | ConvertFrom-Csv
}

$citiesCsv = Import-CleanCsv -Path (Join-Path $ScriptDir 'seed-cities.csv')
$hotelsCsv = Import-CleanCsv -Path (Join-Path $ScriptDir 'seed-hotels.csv')
$roomsCsv  = Import-CleanCsv -Path (Join-Path $ScriptDir 'seed-rooms.csv')
$guestsCsv = Import-CleanCsv -Path (Join-Path $ScriptDir 'seed-guests.csv')

Write-Host "`nLoaded CSVs: $($citiesCsv.Count) cities, $($hotelsCsv.Count) hotels, $($roomsCsv.Count) rooms, $($guestsCsv.Count) guests" -ForegroundColor Cyan

# Build prefix-aware entity set names (plural form Dataverse uses).
$EsCity        = "${Prefix}_cities"
$EsHotel       = "${Prefix}_hotels"
$EsRoom        = "${Prefix}_rooms"
$EsGuest       = "${Prefix}_guests"

# ---------------------------------------------------------------------------
# OPTION-SET RESOLUTION
# ---------------------------------------------------------------------------
# Pull the picklist option values once so we can map labels (e.g. "Single")
# to numeric values without hardcoding them.

function Get-OptionSetMap {
  param([string]$EntitySchema, [string]$AttributeSchema)
  $path = "EntityDefinitions(LogicalName='$($EntitySchema.ToLower())')/Attributes(LogicalName='$($AttributeSchema.ToLower())')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$select=LogicalName&`$expand=OptionSet"
  $resp = Invoke-Dataverse -Method GET -Path $path
  $map = @{}
  foreach ($opt in $resp.OptionSet.Options) {
    $label = $opt.Label.LocalizedLabels[0].Label
    $map[$label] = $opt.Value
  }
  return $map
}

function Get-MultiSelectOptionMap {
  param([string]$EntitySchema, [string]$AttributeSchema)
  $path = "EntityDefinitions(LogicalName='$($EntitySchema.ToLower())')/Attributes(LogicalName='$($AttributeSchema.ToLower())')/Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata?`$select=LogicalName&`$expand=OptionSet"
  $resp = Invoke-Dataverse -Method GET -Path $path
  $map = @{}
  foreach ($opt in $resp.OptionSet.Options) {
    $label = $opt.Label.LocalizedLabels[0].Label
    $map[$label] = $opt.Value
  }
  return $map
}

Write-Host "`n→ Loading option-set mappings…" -ForegroundColor Cyan
$amenityMap = Get-MultiSelectOptionMap -EntitySchema "${Prefix}_hotel"       -AttributeSchema "${Prefix}_amenities"
$roomTypeMap= Get-OptionSetMap        -EntitySchema "${Prefix}_room"        -AttributeSchema "${Prefix}_type"
$statusMap  = Get-OptionSetMap        -EntitySchema "${Prefix}_reservation" -AttributeSchema "${Prefix}_status"

Write-Host "  amenities: $($amenityMap.Count) options"
Write-Host "  room type: $($roomTypeMap.Count) options"
Write-Host "  status:    $($statusMap.Count) options"

# ---------------------------------------------------------------------------
# SEED CITIES
# ---------------------------------------------------------------------------

Write-Host "`n→ Seeding cities…" -ForegroundColor Cyan
$cityIdBySlug = @{}

foreach ($c in $citiesCsv) {
  $slug = $c."${Prefix}_slug"
  $data = @{
    "${Prefix}_name"      = $c."${Prefix}_name"
    "${Prefix}_slug"      = $slug
    "${Prefix}_country"   = $c."${Prefix}_country"
    "${Prefix}_latitude"  = [decimal]$c."${Prefix}_latitude"
    "${Prefix}_longitude" = [decimal]$c."${Prefix}_longitude"
    "${Prefix}_timezone"  = $c."${Prefix}_timezone"
  }
  $id = Upsert-Row -EntitySet $EsCity `
                   -IdField "${Prefix}_cityid" `
                   -MatchFilter "${Prefix}_slug eq '$slug'" `
                   -Data $data `
                   -DisplayName $c."${Prefix}_name"
  $cityIdBySlug[$slug] = $id
}

# ---------------------------------------------------------------------------
# SEED HOTELS (resolve city lookup by slug)
# ---------------------------------------------------------------------------

Write-Host "`n→ Seeding hotels…" -ForegroundColor Cyan
$hotelIdByName = @{}   # keyed by "$hotelName||$citySlug" to disambiguate

foreach ($h in $hotelsCsv) {
  $name      = $h."${Prefix}_name"
  $citySlug  = $h."${Prefix}_city_slug"
  $cityId    = $cityIdBySlug[$citySlug]

  if (-not $cityId) {
    Write-Host "  ! Skipping '$name' — city slug '$citySlug' not found" -ForegroundColor Yellow
    continue
  }

  # Parse amenities (semicolon-separated) into multi-select numeric values
  $amenityValues = @()
  if ($h."${Prefix}_amenities") {
    foreach ($a in $h."${Prefix}_amenities" -split ';') {
      $trimmed = $a.Trim()
      if ($amenityMap.ContainsKey($trimmed)) {
        $amenityValues += $amenityMap[$trimmed]
      } else {
        Write-Host "    ! Unknown amenity '$trimmed' on $name" -ForegroundColor Yellow
      }
    }
  }

  $data = @{
    "${Prefix}_name"                      = $name
    "${Prefix}_address"                   = $h."${Prefix}_address"
    "${Prefix}_stars"                     = [int]$h."${Prefix}_stars"
    "${Prefix}_latitude"                  = [decimal]$h."${Prefix}_latitude"
    "${Prefix}_longitude"                 = [decimal]$h."${Prefix}_longitude"
    "${Prefix}_description"               = $h."${Prefix}_description"
    "${Prefix}_amenities"                 = ($amenityValues -join ',')
    "${Prefix}_City@odata.bind"           = "/$EsCity($cityId)"
  }

  # Match on name + same city to allow rebuilding.
  $filter = "${Prefix}_name eq '$($name -replace "'", "''")' and _${Prefix}_city_value eq $cityId"
  $id = Upsert-Row -EntitySet $EsHotel `
                   -IdField "${Prefix}_hotelid" `
                   -MatchFilter $filter `
                   -Data $data `
                   -DisplayName "$name ($citySlug)"
  $hotelIdByName["$name||$citySlug"] = $id
}

# Also build a simpler hotel-name-only map (works because seed data has unique
# hotel names across all cities; this lets the rooms CSV reference hotels by
# name alone). If you later add same-named hotels in different cities, extend
# the rooms CSV with a city slug column.
$hotelIdByName_NameOnly = @{}
foreach ($k in $hotelIdByName.Keys) {
  $namePart = ($k -split '\|\|')[0]
  $hotelIdByName_NameOnly[$namePart] = $hotelIdByName[$k]
}

# ---------------------------------------------------------------------------
# SEED ROOMS (resolve hotel lookup by name)
# ---------------------------------------------------------------------------

Write-Host "`n→ Seeding rooms…" -ForegroundColor Cyan

foreach ($r in $roomsCsv) {
  $roomName  = $r."${Prefix}_name"
  $hotelName = $r."${Prefix}_hotel_name"
  $hotelId   = $hotelIdByName_NameOnly[$hotelName]

  if (-not $hotelId) {
    Write-Host "  ! Skipping room '$roomName' — hotel '$hotelName' not found" -ForegroundColor Yellow
    continue
  }

  $typeLabel = $r."${Prefix}_type"
  if (-not $roomTypeMap.ContainsKey($typeLabel)) {
    Write-Host "    ! Unknown room type '$typeLabel' on $roomName" -ForegroundColor Yellow
    continue
  }

  $data = @{
    "${Prefix}_name"                = $roomName
    "${Prefix}_type"                = $roomTypeMap[$typeLabel]
    "${Prefix}_capacity"            = [int]$r."${Prefix}_capacity"
    "${Prefix}_pricepernight"       = [decimal]$r."${Prefix}_pricepernight"
    "${Prefix}_quantityavailable"   = [int]$r."${Prefix}_quantityavailable"
    "${Prefix}_Hotel@odata.bind"    = "/$EsHotel($hotelId)"
  }

  # Match on name + hotel for idempotency.
  $escapedRoom = $roomName -replace "'", "''"
  $filter = "${Prefix}_name eq '$escapedRoom' and _${Prefix}_hotel_value eq $hotelId"
  Upsert-Row -EntitySet $EsRoom `
             -IdField "${Prefix}_roomid" `
             -MatchFilter $filter `
             -Data $data `
             -DisplayName "$roomName @ $hotelName" | Out-Null
}

# ---------------------------------------------------------------------------
# SEED GUESTS
# ---------------------------------------------------------------------------

Write-Host "`n→ Seeding guests…" -ForegroundColor Cyan

foreach ($g in $guestsCsv) {
  $email = $g."${Prefix}_email"
  $data = @{
    "${Prefix}_fullname"      = $g."${Prefix}_fullname"
    "${Prefix}_email"         = $email
    "${Prefix}_phone"         = $g."${Prefix}_phone"
    "${Prefix}_loyaltynumber" = $g."${Prefix}_loyaltynumber"
  }

  $escapedEmail = $email -replace "'", "''"
  Upsert-Row -EntitySet $EsGuest `
             -IdField "${Prefix}_guestid" `
             -MatchFilter "${Prefix}_email eq '$escapedEmail'" `
             -Data $data `
             -DisplayName $g."${Prefix}_fullname" | Out-Null
}

# ---------------------------------------------------------------------------
# DONE
# ---------------------------------------------------------------------------

Write-Host "`n✓ Seeding complete." -ForegroundColor Green
Write-Host @"

Verify in https://make.powerapps.com → your environment → Tables:
  ${Prefix}_cities       should have $($citiesCsv.Count) rows
  ${Prefix}_hotels       should have $($hotelsCsv.Count) rows
  ${Prefix}_rooms        should have $($roomsCsv.Count) rows
  ${Prefix}_guests       should have $($guestsCsv.Count) rows

Spot-check a hotel row: its City lookup should be populated.
Spot-check a room row: its Hotel lookup should be populated.

"@ -ForegroundColor Cyan
