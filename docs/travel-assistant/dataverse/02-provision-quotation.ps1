#requires -Version 7.0
<#
.SYNOPSIS
  v2 Phase 1 — provisions the three quotation tables into the existing
  TravelAssistant solution: tra_quotation (parent), tra_quotation_day,
  and tra_quotation_activity. Reuses the same Web API + Azure CLI auth
  pattern as 00-provision-solution.ps1.

.PREREQUISITES
  1. az login
  2. The base TravelAssistant solution already provisioned (run
     00-provision-solution.ps1 first).

.USAGE
  pwsh ./02-provision-quotation.ps1 -EnvironmentUrl https://myorg.crm4.dynamics.com

.NOTES
  Idempotent-ish: skips entities/attributes that already exist by SchemaName.
  Lookups are created in a final pass after all entities exist.

  TABLES CREATED
    tra_quotation           one row per quote (the parent)
    tra_quotation_day       one row per day of the itinerary
    tra_quotation_activity  one row per planned activity within a day

  RELATIONSHIPS
    tra_quotation_day.tra_Quotation        → tra_quotation   (N:1)
    tra_quotation_activity.tra_QuotationDay → tra_quotation_day (N:1)
    tra_quotation.tra_Guest                → tra_guest       (N:1)
    tra_quotation.tra_DestinationCity      → tra_city        (N:1)
    tra_quotation.tra_Hotel                → tra_hotel       (N:1)
    tra_quotation.tra_Room                 → tra_room        (N:1)
    tra_quotation.tra_Reservation          → tra_reservation (N:1)
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$EnvironmentUrl,

  [string]$Prefix         = 'tra',
  [string]$SolutionName   = 'TravelAssistant',
  [string]$ApiVersion     = 'v9.2'
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
  Write-Error "Couldn't get a token. Run 'az login' first, then re-run this script."
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

$SolutionHeader = @{ 'MSCRM.SolutionUniqueName' = $SolutionName }

# ---------------------------------------------------------------------------
# HELPERS (same as base script)
# ---------------------------------------------------------------------------

function Invoke-Dataverse {
  param([string]$Method, [string]$Path, $Body = $null, [hashtable]$ExtraHeaders = @{})
  $url = "$ApiBase/$Path"
  $allHeaders = @{} + $Headers
  foreach ($k in $ExtraHeaders.Keys) { $allHeaders[$k] = $ExtraHeaders[$k] }
  $params = @{ Method = $Method; Uri = $url; Headers = $allHeaders }
  if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 30) }
  try {
    return Invoke-RestMethod @params
  } catch {
    $resp = $_.Exception.Response
    $body = ''
    if ($resp) { try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {} }
    Write-Host "  ✗ $Method $url" -ForegroundColor Red
    if ($body) { Write-Host "    $body" -ForegroundColor DarkRed }
    throw
  }
}

function Get-Localized {
  param([string]$Value)
  return @{
    '@odata.type'   = 'Microsoft.Dynamics.CRM.Label'
    LocalizedLabels = @(@{
      '@odata.type' = 'Microsoft.Dynamics.CRM.LocalizedLabel'
      Label         = $Value
      LanguageCode  = 1033
    })
  }
}

function Test-EntityExists {
  param([string]$SchemaName)
  try { Invoke-Dataverse -Method GET -Path "EntityDefinitions(LogicalName='$($SchemaName.ToLower())')?`$select=SchemaName" | Out-Null; return $true }
  catch { return $false }
}

function Test-AttributeExists {
  param([string]$EntitySchema, [string]$AttributeSchema)
  try { Invoke-Dataverse -Method GET -Path "EntityDefinitions(LogicalName='$($EntitySchema.ToLower())')/Attributes(LogicalName='$($AttributeSchema.ToLower())')?`$select=SchemaName" | Out-Null; return $true }
  catch { return $false }
}

# ---------------------------------------------------------------------------
# COLUMN FACTORIES (same as base script)
# ---------------------------------------------------------------------------

function New-StringAttribute {
  param([string]$Schema, [string]$Display, [int]$MaxLength = 100, [string]$Format = 'Text', [bool]$Required = $false)
  @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
    SchemaName    = $Schema
    DisplayName   = (Get-Localized $Display)
    RequiredLevel = @{ Value = ($(if($Required){'ApplicationRequired'} else {'None'})) }
    MaxLength     = $MaxLength
    FormatName    = @{ Value = $Format }
  }
}

function New-MemoAttribute {
  param([string]$Schema, [string]$Display, [int]$MaxLength = 2000)
  @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.MemoAttributeMetadata'
    SchemaName    = $Schema
    DisplayName   = (Get-Localized $Display)
    RequiredLevel = @{ Value = 'None' }
    MaxLength     = $MaxLength
    Format        = 'TextArea'
  }
}

function New-IntegerAttribute {
  param([string]$Schema, [string]$Display, [int]$Min = -2147483648, [int]$Max = 2147483647)
  @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata'
    SchemaName    = $Schema
    DisplayName   = (Get-Localized $Display)
    RequiredLevel = @{ Value = 'None' }
    MinValue      = $Min
    MaxValue      = $Max
    Format        = 'None'
  }
}

function New-MoneyAttribute {
  param([string]$Schema, [string]$Display)
  @{
    '@odata.type'   = 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata'
    SchemaName      = $Schema
    DisplayName     = (Get-Localized $Display)
    RequiredLevel   = @{ Value = 'None' }
    PrecisionSource = 2
  }
}

function New-DateAttribute {
  param([string]$Schema, [string]$Display)
  @{
    '@odata.type'    = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'
    SchemaName       = $Schema
    DisplayName      = (Get-Localized $Display)
    RequiredLevel    = @{ Value = 'None' }
    Format           = 'DateOnly'
    DateTimeBehavior = @{ Value = 'DateOnly' }
  }
}

function New-PicklistAttribute {
  param([string]$Schema, [string]$Display, [string[]]$Options, [int]$StartValue)
  $items = @()
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $items += @{ Value = ($StartValue + $i); Label = (Get-Localized $Options[$i]) }
  }
  @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
    SchemaName    = $Schema
    DisplayName   = (Get-Localized $Display)
    RequiredLevel = @{ Value = 'None' }
    OptionSet     = @{
      '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'
      IsGlobal      = $false
      OptionSetType = 'Picklist'
      Options       = $items
    }
  }
}

function New-AutoNumberAttribute {
  param([string]$Schema, [string]$Display, [string]$Format = 'Q-{SEQNUM:6}')
  @{
    '@odata.type'    = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
    SchemaName       = $Schema
    DisplayName      = (Get-Localized $Display)
    RequiredLevel    = @{ Value = 'None' }
    MaxLength        = 100
    FormatName       = @{ Value = 'Text' }
    AutoNumberFormat = $Format
  }
}

function New-Entity {
  param(
    [string]$Schema, [string]$DisplayName, [string]$DisplayCollection,
    [string]$Description, [string]$PrimaryNameSchema, [string]$PrimaryNameDisplay,
    [int]$PrimaryNameMaxLength = 200
  )
  if (Test-EntityExists -SchemaName $Schema) {
    Write-Host "  ↺ $Schema already exists, skipping create" -ForegroundColor DarkGray
    return
  }
  $entity = @{
    '@odata.type'         = 'Microsoft.Dynamics.CRM.EntityMetadata'
    SchemaName            = $Schema
    DisplayName           = (Get-Localized $DisplayName)
    DisplayCollectionName = (Get-Localized $DisplayCollection)
    Description           = (Get-Localized $Description)
    HasActivities         = $false
    HasNotes              = $false
    OwnershipType         = 'UserOwned'
    IsActivity            = $false
    Attributes            = @(@{
      '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
      SchemaName    = $PrimaryNameSchema
      DisplayName   = (Get-Localized $PrimaryNameDisplay)
      RequiredLevel = @{ Value = 'ApplicationRequired' }
      MaxLength     = $PrimaryNameMaxLength
      FormatName    = @{ Value = 'Text' }
      IsPrimaryName = $true
    })
  }
  Write-Host "  + $Schema" -ForegroundColor Green
  Invoke-Dataverse -Method POST -Path 'EntityDefinitions' -Body $entity -ExtraHeaders $SolutionHeader | Out-Null
}

function Add-Attribute {
  param([string]$EntitySchema, $Attribute)
  $attrSchema = $Attribute.SchemaName
  if (Test-AttributeExists -EntitySchema $EntitySchema -AttributeSchema $attrSchema) {
    Write-Host "    ↺ $attrSchema exists" -ForegroundColor DarkGray
    return
  }
  Write-Host "    + $attrSchema" -ForegroundColor DarkGreen
  Invoke-Dataverse -Method POST `
    -Path "EntityDefinitions(LogicalName='$($EntitySchema.ToLower())')/Attributes" `
    -Body $Attribute -ExtraHeaders $SolutionHeader | Out-Null
}

function Add-Lookup {
  param(
    [string]$ChildEntity, [string]$ParentEntity, [string]$LookupSchema,
    [string]$LookupDisplay, [string]$RelationshipSchema
  )
  if (Test-AttributeExists -EntitySchema $ChildEntity -AttributeSchema $LookupSchema) {
    Write-Host "    ↺ $LookupSchema lookup exists" -ForegroundColor DarkGray
    return
  }
  $body = @{
    '@odata.type'               = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'
    SchemaName                  = $RelationshipSchema
    ReferencedEntity            = $ParentEntity.ToLower()
    ReferencingEntity           = $ChildEntity.ToLower()
    AssociatedMenuConfiguration = @{ Behavior = 'UseCollectionName'; Group = 'Details'; Order = 10000 }
    CascadeConfiguration        = @{
      Assign = 'NoCascade'; Delete = 'RemoveLink'; Merge = 'NoCascade'
      Reparent = 'NoCascade'; Share = 'NoCascade'; Unshare = 'NoCascade'
    }
    Lookup                      = @{
      '@odata.type' = 'Microsoft.Dynamics.CRM.LookupAttributeMetadata'
      SchemaName    = $LookupSchema
      DisplayName   = (Get-Localized $LookupDisplay)
      RequiredLevel = @{ Value = 'None' }
    }
  }
  Write-Host "    + lookup $LookupSchema → $ParentEntity" -ForegroundColor DarkGreen
  Invoke-Dataverse -Method POST -Path 'RelationshipDefinitions' -Body $body -ExtraHeaders $SolutionHeader | Out-Null
}

# ---------------------------------------------------------------------------
# PASS 1: CREATE ENTITIES (primary name only)
# ---------------------------------------------------------------------------

Write-Host "`n→ Creating quotation entities…" -ForegroundColor Cyan

New-Entity -Schema "${Prefix}_Quotation" `
  -DisplayName 'Quotation' -DisplayCollection 'Quotations' `
  -Description 'A travel quotation assembled from hotel, itinerary, and flight components' `
  -PrimaryNameSchema "${Prefix}_QuoteNumber" -PrimaryNameDisplay 'Quote Number'

New-Entity -Schema "${Prefix}_QuotationDay" `
  -DisplayName 'Quotation Day' -DisplayCollection 'Quotation Days' `
  -Description 'One day of a quotation itinerary' `
  -PrimaryNameSchema "${Prefix}_Name" -PrimaryNameDisplay 'Name'

New-Entity -Schema "${Prefix}_QuotationActivity" `
  -DisplayName 'Quotation Activity' -DisplayCollection 'Quotation Activities' `
  -Description 'A single activity planned within a quotation day' `
  -PrimaryNameSchema "${Prefix}_Name" -PrimaryNameDisplay 'Name'

Write-Host "`n  Waiting 10s for entity metadata to settle…" -ForegroundColor DarkGray
Start-Sleep -Seconds 10

# ---------------------------------------------------------------------------
# PASS 2: ADD COLUMNS
# ---------------------------------------------------------------------------

Write-Host "`n→ Adding columns to ${Prefix}_Quotation…" -ForegroundColor Cyan

# Override the primary name to be an autonumber Q-000001.
$qnoUpdate = @{
  '@odata.type'    = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
  AutoNumberFormat = 'Q-{SEQNUM:6}'
}
try {
  Invoke-Dataverse -Method PUT `
    -Path "EntityDefinitions(LogicalName='${Prefix}_quotation')/Attributes(LogicalName='${Prefix}_quotenumber')" `
    -Body $qnoUpdate -ExtraHeaders $SolutionHeader | Out-Null
  Write-Host "    ✓ QuoteNumber autonumber format set" -ForegroundColor DarkGreen
} catch {
  Write-Host "    ! Could not set autonumber on QuoteNumber (set it manually in maker portal: Q-{SEQNUM:6})" -ForegroundColor Yellow
}

Add-Attribute "${Prefix}_Quotation" (New-PicklistAttribute "${Prefix}_Status" 'Status' @('Draft','Confirmed','Sent','Expired','Cancelled') 100000000)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OriginCity"        'Origin City' 100)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OriginIata"        'Origin IATA' 8)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_DestinationIata"   'Destination IATA' 8)
Add-Attribute "${Prefix}_Quotation" (New-DateAttribute    "${Prefix}_CheckInDate"       'Check-in Date')
Add-Attribute "${Prefix}_Quotation" (New-DateAttribute    "${Prefix}_CheckOutDate"      'Check-out Date')
Add-Attribute "${Prefix}_Quotation" (New-IntegerAttribute "${Prefix}_Nights"            'Nights' 0 365)
Add-Attribute "${Prefix}_Quotation" (New-IntegerAttribute "${Prefix}_Adults"            'Adults' 0 20)
Add-Attribute "${Prefix}_Quotation" (New-IntegerAttribute "${Prefix}_Children"          'Children' 0 20)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_Currency"          'Currency' 8)
Add-Attribute "${Prefix}_Quotation" (New-MoneyAttribute   "${Prefix}_HotelSubtotal"     'Hotel Subtotal')
Add-Attribute "${Prefix}_Quotation" (New-MoneyAttribute   "${Prefix}_ActivitiesSubtotal" 'Activities Subtotal')
Add-Attribute "${Prefix}_Quotation" (New-MoneyAttribute   "${Prefix}_FlightsSubtotal"   'Flights Subtotal')
Add-Attribute "${Prefix}_Quotation" (New-MoneyAttribute   "${Prefix}_TotalPrice"        'Total Price')
Add-Attribute "${Prefix}_Quotation" (New-MemoAttribute    "${Prefix}_DestinationSummary" 'Destination Summary' 4000)
Add-Attribute "${Prefix}_Quotation" (New-MemoAttribute    "${Prefix}_WeatherSummary"    'Weather Summary' 1000)
Add-Attribute "${Prefix}_Quotation" (New-MemoAttribute    "${Prefix}_Notes"             'Notes' 2000)
Add-Attribute "${Prefix}_Quotation" (New-DateAttribute    "${Prefix}_ValidUntil"        'Valid Until')
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_DocumentUrl"       'Document URL' 500 'Url')
# Outbound flight
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OutboundCarrier"   'Outbound Carrier' 100)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OutboundFlight"    'Outbound Flight' 20)
Add-Attribute "${Prefix}_Quotation" (New-DateAttribute    "${Prefix}_OutboundDate"      'Outbound Date')
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OutboundDepTime"   'Outbound Departure Time' 10)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_OutboundArrTime"   'Outbound Arrival Time' 10)
# Return flight
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_ReturnCarrier"     'Return Carrier' 100)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_ReturnFlight"      'Return Flight' 20)
Add-Attribute "${Prefix}_Quotation" (New-DateAttribute    "${Prefix}_ReturnDate"        'Return Date')
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_ReturnDepTime"     'Return Departure Time' 10)
Add-Attribute "${Prefix}_Quotation" (New-StringAttribute  "${Prefix}_ReturnArrTime"     'Return Arrival Time' 10)

Write-Host "`n→ Adding columns to ${Prefix}_QuotationDay…" -ForegroundColor Cyan
Add-Attribute "${Prefix}_QuotationDay" (New-IntegerAttribute "${Prefix}_DayNumber"       'Day Number' 1 60)
Add-Attribute "${Prefix}_QuotationDay" (New-DateAttribute    "${Prefix}_Date"            'Date')
Add-Attribute "${Prefix}_QuotationDay" (New-MemoAttribute    "${Prefix}_MorningSummary"  'Morning Summary' 1000)
Add-Attribute "${Prefix}_QuotationDay" (New-MemoAttribute    "${Prefix}_AfternoonSummary" 'Afternoon Summary' 1000)
Add-Attribute "${Prefix}_QuotationDay" (New-MemoAttribute    "${Prefix}_EveningSummary"  'Evening Summary' 1000)
Add-Attribute "${Prefix}_QuotationDay" (New-MoneyAttribute   "${Prefix}_DayTotal"        'Day Total')
Add-Attribute "${Prefix}_QuotationDay" (New-StringAttribute  "${Prefix}_Weather"         'Weather' 100)

Write-Host "`n→ Adding columns to ${Prefix}_QuotationActivity…" -ForegroundColor Cyan
Add-Attribute "${Prefix}_QuotationActivity" (New-StringAttribute  "${Prefix}_ActivitySourceId" 'Activity Source Id' 100)
Add-Attribute "${Prefix}_QuotationActivity" (New-PicklistAttribute "${Prefix}_TimeSlot" 'Time Slot' @('Morning','Afternoon','Evening') 100000000)
Add-Attribute "${Prefix}_QuotationActivity" (New-StringAttribute  "${Prefix}_StartTime"        'Start Time' 10)
Add-Attribute "${Prefix}_QuotationActivity" (New-IntegerAttribute "${Prefix}_DurationMinutes"  'Duration Minutes' 0 1440)
Add-Attribute "${Prefix}_QuotationActivity" (New-MoneyAttribute   "${Prefix}_EstimatedCost"    'Estimated Cost')
Add-Attribute "${Prefix}_QuotationActivity" (New-StringAttribute  "${Prefix}_Category"         'Category' 60)
Add-Attribute "${Prefix}_QuotationActivity" (New-MemoAttribute    "${Prefix}_Description"      'Description' 1000)

# ---------------------------------------------------------------------------
# PASS 3: LOOKUPS (after all entities exist)
# ---------------------------------------------------------------------------

Write-Host "`n→ Creating relationships…" -ForegroundColor Cyan

Add-Lookup -ChildEntity "${Prefix}_QuotationDay" -ParentEntity "${Prefix}_Quotation" `
  -LookupSchema "${Prefix}_Quotation" -LookupDisplay 'Quotation' `
  -RelationshipSchema "${Prefix}_quotation_quotationday"

Add-Lookup -ChildEntity "${Prefix}_QuotationActivity" -ParentEntity "${Prefix}_QuotationDay" `
  -LookupSchema "${Prefix}_QuotationDay" -LookupDisplay 'Quotation Day' `
  -RelationshipSchema "${Prefix}_quotationday_quotationactivity"

Add-Lookup -ChildEntity "${Prefix}_Quotation" -ParentEntity "${Prefix}_Guest" `
  -LookupSchema "${Prefix}_Guest" -LookupDisplay 'Guest' `
  -RelationshipSchema "${Prefix}_guest_quotation"

Add-Lookup -ChildEntity "${Prefix}_Quotation" -ParentEntity "${Prefix}_City" `
  -LookupSchema "${Prefix}_DestinationCity" -LookupDisplay 'Destination City' `
  -RelationshipSchema "${Prefix}_city_quotation"

Add-Lookup -ChildEntity "${Prefix}_Quotation" -ParentEntity "${Prefix}_Hotel" `
  -LookupSchema "${Prefix}_Hotel" -LookupDisplay 'Hotel' `
  -RelationshipSchema "${Prefix}_hotel_quotation"

Add-Lookup -ChildEntity "${Prefix}_Quotation" -ParentEntity "${Prefix}_Room" `
  -LookupSchema "${Prefix}_Room" -LookupDisplay 'Room' `
  -RelationshipSchema "${Prefix}_room_quotation"

Add-Lookup -ChildEntity "${Prefix}_Quotation" -ParentEntity "${Prefix}_Reservation" `
  -LookupSchema "${Prefix}_Reservation" -LookupDisplay 'Reservation' `
  -RelationshipSchema "${Prefix}_reservation_quotation"

# ---------------------------------------------------------------------------
# PUBLISH
# ---------------------------------------------------------------------------

Write-Host "`n→ Publishing customizations…" -ForegroundColor Cyan
try {
  Invoke-Dataverse -Method POST -Path 'PublishAllXml' | Out-Null
  Write-Host "  ✓ Published" -ForegroundColor Green
} catch {
  Write-Host "  ! Publish call failed; publish manually in maker portal." -ForegroundColor Yellow
}

Write-Host "`n✓ Phase 1 complete. Three quotation tables provisioned." -ForegroundColor Green
Write-Host @"

NEXT STEPS
  1. Verify in make.powerapps.com → Tables: tra_quotation, tra_quotation_day,
     tra_quotation_activity all present with their columns and lookups.
  2. Confirm the QuoteNumber autonumber shows format Q-000001. If the script
     warned it couldn't set it, open the column and set Auto-number → Q-{SEQNUM:6}.
  3. Move on to Phase 2: the five quotation flows.

"@ -ForegroundColor Cyan