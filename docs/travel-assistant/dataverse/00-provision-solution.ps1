#requires -Version 7.0
<#
.SYNOPSIS
  Provisions the TravelAssistant Dataverse solution end-to-end via the
  Web API: publisher, solution, 5 custom tables, columns, choice options,
  and lookup relationships.

.PREREQUISITES
  1. Install Azure CLI:    https://aka.ms/installazurecli
  2. Login:                az login
  3. Know your environment URL, e.g. https://myorg.crm4.dynamics.com

.USAGE
  pwsh ./00-provision-solution.ps1 -EnvironmentUrl https://myorg.crm4.dynamics.com

.NOTES
  Idempotent-ish: skips entities that already exist by SchemaName. To
  rebuild from scratch, delete the solution and unmanaged components
  in make.powerapps.com first.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$EnvironmentUrl,

  [string]$Prefix         = 'tra',
  [int]$PrefixOption      = 10000,   # custom option-set prefix; must match prefix
  [string]$PublisherName  = 'TravelAssistantPublisher',
  [string]$PublisherDisp  = 'Travel Assistant Publisher',
  [string]$SolutionName   = 'TravelAssistant',
  [string]$SolutionDisp   = 'Travel Assistant',
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

# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

function Invoke-Dataverse {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null,
    [hashtable]$ExtraHeaders = @{}
  )
  $url = "$ApiBase/$Path"
  $allHeaders = @{} + $Headers
  foreach ($k in $ExtraHeaders.Keys) { $allHeaders[$k] = $ExtraHeaders[$k] }

  $params = @{
    Method  = $Method
    Uri     = $url
    Headers = $allHeaders
  }
  if ($Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
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

function Get-Localized {
  param([string]$Value)
  return @{
    '@odata.type'             = 'Microsoft.Dynamics.CRM.Label'
    LocalizedLabels           = @(@{
      '@odata.type'           = 'Microsoft.Dynamics.CRM.LocalizedLabel'
      Label                   = $Value
      LanguageCode            = 1033
    })
  }
}

function Test-EntityExists {
  param([string]$SchemaName)
  try {
    $r = Invoke-Dataverse -Method GET -Path "EntityDefinitions(LogicalName='$($SchemaName.ToLower())')?`$select=SchemaName"
    return $true
  } catch { return $false }
}

function Test-AttributeExists {
  param([string]$EntitySchema, [string]$AttributeSchema)
  try {
    $r = Invoke-Dataverse -Method GET -Path "EntityDefinitions(LogicalName='$($EntitySchema.ToLower())')/Attributes(LogicalName='$($AttributeSchema.ToLower())')?`$select=SchemaName"
    return $true
  } catch { return $false }
}

# ---------------------------------------------------------------------------
# PUBLISHER + SOLUTION
# ---------------------------------------------------------------------------

Write-Host "`n→ Ensuring publisher '$PublisherName'…" -ForegroundColor Cyan
$pubResp = Invoke-Dataverse -Method GET -Path "publishers?`$filter=uniquename eq '$PublisherName'&`$select=publisherid,uniquename"
if ($pubResp.value.Count -eq 0) {
  $pubBody = @{
    uniquename            = $PublisherName
    friendlyname          = $PublisherDisp
    customizationprefix   = $Prefix
    customizationoptionvalueprefix = $PrefixOption
  }
  $pub = Invoke-Dataverse -Method POST -Path 'publishers' -Body $pubBody
  $PublisherId = $pub.publisherid
  Write-Host "  ✓ Publisher created: $PublisherId" -ForegroundColor Green
} else {
  $PublisherId = $pubResp.value[0].publisherid
  Write-Host "  ✓ Publisher exists: $PublisherId" -ForegroundColor Green
}

Write-Host "`n→ Ensuring solution '$SolutionName'…" -ForegroundColor Cyan
$solResp = Invoke-Dataverse -Method GET -Path "solutions?`$filter=uniquename eq '$SolutionName'&`$select=solutionid,uniquename"
if ($solResp.value.Count -eq 0) {
  $solBody = @{
    uniquename               = $SolutionName
    friendlyname             = $SolutionDisp
    version                  = '1.0.0.0'
    'publisherid@odata.bind' = "/publishers($PublisherId)"
  }
  $sol = Invoke-Dataverse -Method POST -Path 'solutions' -Body $solBody
  $SolutionId = $sol.solutionid
  Write-Host "  ✓ Solution created: $SolutionId" -ForegroundColor Green
} else {
  $SolutionId = $solResp.value[0].solutionid
  Write-Host "  ✓ Solution exists: $SolutionId" -ForegroundColor Green
}

# Header used for adding components to the solution as we create them.
$SolutionHeader = @{ 'MSCRM.SolutionUniqueName' = $SolutionName }

# ---------------------------------------------------------------------------
# COLUMN FACTORIES (build attribute definitions)
# ---------------------------------------------------------------------------

function New-StringAttribute {
  param([string]$Schema, [string]$Display, [int]$MaxLength = 100, [string]$Format = 'Text', [bool]$Required = $false)
  @{
    '@odata.type'   = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
    SchemaName      = $Schema
    DisplayName     = (Get-Localized $Display)
    RequiredLevel   = @{ Value = ($(if($Required){'ApplicationRequired'} else {'None'})) }
    MaxLength       = $MaxLength
    FormatName      = @{ Value = $Format }   # Text, Email, Phone, Url
  }
}

function New-MemoAttribute {
  param([string]$Schema, [string]$Display, [int]$MaxLength = 2000)
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.MemoAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    MaxLength      = $MaxLength
    Format         = 'TextArea'
  }
}

function New-IntegerAttribute {
  param([string]$Schema, [string]$Display, [int]$Min = -2147483648, [int]$Max = 2147483647)
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    MinValue       = $Min
    MaxValue       = $Max
    Format         = 'None'
  }
}

function New-DecimalAttribute {
  param([string]$Schema, [string]$Display, [int]$Precision = 2)
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    Precision      = $Precision
    MinValue       = -100000000
    MaxValue       =  100000000
  }
}

function New-MoneyAttribute {
  param([string]$Schema, [string]$Display)
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    PrecisionSource= 2
  }
}

function New-DateAttribute {
  param([string]$Schema, [string]$Display)
  @{
    '@odata.type'   = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'
    SchemaName      = $Schema
    DisplayName     = (Get-Localized $Display)
    RequiredLevel   = @{ Value = 'None' }
    Format          = 'DateOnly'
    DateTimeBehavior= @{ Value = 'DateOnly' }
  }
}

function New-PicklistAttribute {
  param([string]$Schema, [string]$Display, [string[]]$Options, [int]$StartValue)
  $items = @()
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $items += @{
      Value = ($StartValue + $i)
      Label = (Get-Localized $Options[$i])
    }
  }
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    OptionSet      = @{
      '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'
      IsGlobal      = $false
      OptionSetType = 'Picklist'
      Options       = $items
    }
  }
}

function New-MultiSelectAttribute {
  param([string]$Schema, [string]$Display, [string[]]$Options, [int]$StartValue)
  $items = @()
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $items += @{
      Value = ($StartValue + $i)
      Label = (Get-Localized $Options[$i])
    }
  }
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    OptionSet      = @{
      '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'
      IsGlobal      = $false
      OptionSetType = 'Picklist'
      Options       = $items
    }
  }
}

function New-BooleanAttribute {
  param([string]$Schema, [string]$Display)
  @{
    '@odata.type'  = 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata'
    SchemaName     = $Schema
    DisplayName    = (Get-Localized $Display)
    RequiredLevel  = @{ Value = 'None' }
    DefaultValue   = $false
    OptionSet      = @{
      '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata'
      TrueOption    = @{ Value = 1; Label = (Get-Localized 'Yes') }
      FalseOption   = @{ Value = 0; Label = (Get-Localized 'No') }
    }
  }
}

function New-AutoNumberAttribute {
  param([string]$Schema, [string]$Display, [string]$Format = 'RES-{SEQNUM:6}', [int]$Seed = 1000)
  @{
    '@odata.type'      = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
    SchemaName         = $Schema
    DisplayName        = (Get-Localized $Display)
    RequiredLevel      = @{ Value = 'None' }
    MaxLength          = 100
    FormatName         = @{ Value = 'Text' }
    AutoNumberFormat   = $Format
  }
}

# ---------------------------------------------------------------------------
# ENTITY DEFINITIONS
# ---------------------------------------------------------------------------
# Each entity needs a primary name column inline at creation.
# Other columns are added in a second pass. Lookups are created in a third
# pass via OneToManyRelationships, after all entities exist.

function New-Entity {
  param(
    [string]$Schema,
    [string]$DisplayName,
    [string]$DisplayCollection,
    [string]$Description,
    [string]$PrimaryNameSchema,
    [string]$PrimaryNameDisplay,
    [int]$PrimaryNameMaxLength = 100
  )

  if (Test-EntityExists -SchemaName $Schema) {
    Write-Host "  ↺ $Schema already exists, skipping create" -ForegroundColor DarkGray
    return
  }

  $entity = @{
    '@odata.type'              = 'Microsoft.Dynamics.CRM.EntityMetadata'
    SchemaName                 = $Schema
    DisplayName                = (Get-Localized $DisplayName)
    DisplayCollectionName      = (Get-Localized $DisplayCollection)
    Description                = (Get-Localized $Description)
    HasActivities              = $false
    HasNotes                   = $false
    OwnershipType              = 'UserOwned'
    IsActivity                 = $false
    Attributes                 = @(
      @{
        '@odata.type'   = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
        SchemaName      = $PrimaryNameSchema
        DisplayName     = (Get-Localized $PrimaryNameDisplay)
        RequiredLevel   = @{ Value = 'ApplicationRequired' }
        MaxLength       = $PrimaryNameMaxLength
        FormatName      = @{ Value = 'Text' }
        IsPrimaryName   = $true
      }
    )
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
    -Body $Attribute `
    -ExtraHeaders $SolutionHeader | Out-Null
}

function Add-Lookup {
  param(
    [string]$ChildEntity,         # the "many" side
    [string]$ParentEntity,        # the "one" side
    [string]$LookupSchema,        # column name on the child
    [string]$LookupDisplay,
    [string]$RelationshipSchema
  )

  if (Test-AttributeExists -EntitySchema $ChildEntity -AttributeSchema $LookupSchema) {
    Write-Host "    ↺ $LookupSchema lookup exists" -ForegroundColor DarkGray
    return
  }

  $body = @{
    '@odata.type'              = 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata'
    SchemaName                 = $RelationshipSchema
    ReferencedEntity           = $ParentEntity.ToLower()
    ReferencingEntity          = $ChildEntity.ToLower()
    AssociatedMenuConfiguration = @{
      Behavior = 'UseCollectionName'
      Group    = 'Details'
      Order    = 10000
    }
    CascadeConfiguration       = @{
      Assign  = 'NoCascade'; Delete  = 'RemoveLink'
      Merge   = 'NoCascade'; Reparent= 'NoCascade'
      Share   = 'NoCascade'; Unshare = 'NoCascade'
    }
    Lookup                     = @{
      '@odata.type'  = 'Microsoft.Dynamics.CRM.LookupAttributeMetadata'
      SchemaName     = $LookupSchema
      DisplayName    = (Get-Localized $LookupDisplay)
      RequiredLevel  = @{ Value = 'None' }
    }
  }
  Write-Host "    + lookup $LookupSchema → $ParentEntity" -ForegroundColor DarkGreen
  Invoke-Dataverse -Method POST -Path 'RelationshipDefinitions' -Body $body -ExtraHeaders $SolutionHeader | Out-Null
}

# ---------------------------------------------------------------------------
# PASS 1: CREATE ENTITIES (with primary name only)
# ---------------------------------------------------------------------------

Write-Host "`n→ Creating entities…" -ForegroundColor Cyan

New-Entity -Schema "${Prefix}_City"         -DisplayName 'City'        -DisplayCollection 'Cities'        -Description 'A travel destination city'     -PrimaryNameSchema "${Prefix}_Name" -PrimaryNameDisplay 'Name'
New-Entity -Schema "${Prefix}_Hotel"        -DisplayName 'Hotel'       -DisplayCollection 'Hotels'        -Description 'A bookable hotel property'     -PrimaryNameSchema "${Prefix}_Name" -PrimaryNameDisplay 'Name'
New-Entity -Schema "${Prefix}_Room"         -DisplayName 'Room'        -DisplayCollection 'Rooms'         -Description 'A hotel room type'             -PrimaryNameSchema "${Prefix}_Name" -PrimaryNameDisplay 'Name'
New-Entity -Schema "${Prefix}_Guest"        -DisplayName 'Guest'       -DisplayCollection 'Guests'        -Description 'A hotel guest'                 -PrimaryNameSchema "${Prefix}_Fullname" -PrimaryNameDisplay 'Full name'
New-Entity -Schema "${Prefix}_Reservation"  -DisplayName 'Reservation' -DisplayCollection 'Reservations'  -Description 'A hotel reservation'           -PrimaryNameSchema "${Prefix}_Confirmationcode" -PrimaryNameDisplay 'Confirmation code'

# Tables aren't queryable immediately after creation; small pause helps.
Start-Sleep -Seconds 2

# ---------------------------------------------------------------------------
# PASS 2: ADD COLUMNS
# ---------------------------------------------------------------------------

Write-Host "`n→ Adding columns…" -ForegroundColor Cyan

Write-Host "  ${Prefix}_City"
Add-Attribute -EntitySchema "${Prefix}_City" -Attribute (New-StringAttribute  -Schema "${Prefix}_Slug"       -Display 'Slug'     -MaxLength 50)
Add-Attribute -EntitySchema "${Prefix}_City" -Attribute (New-StringAttribute  -Schema "${Prefix}_Country"    -Display 'Country'  -MaxLength 100)
Add-Attribute -EntitySchema "${Prefix}_City" -Attribute (New-DecimalAttribute -Schema "${Prefix}_Latitude"   -Display 'Latitude'  -Precision 6)
Add-Attribute -EntitySchema "${Prefix}_City" -Attribute (New-DecimalAttribute -Schema "${Prefix}_Longitude"  -Display 'Longitude' -Precision 6)
Add-Attribute -EntitySchema "${Prefix}_City" -Attribute (New-StringAttribute  -Schema "${Prefix}_Timezone"   -Display 'Timezone'  -MaxLength 50)

Write-Host "  ${Prefix}_Hotel"
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-StringAttribute       -Schema "${Prefix}_Address"     -Display 'Address'     -MaxLength 250)
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-IntegerAttribute      -Schema "${Prefix}_Stars"       -Display 'Stars'       -Min 1 -Max 5)
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-DecimalAttribute      -Schema "${Prefix}_Latitude"    -Display 'Latitude'    -Precision 6)
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-DecimalAttribute      -Schema "${Prefix}_Longitude"   -Display 'Longitude'   -Precision 6)
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-MemoAttribute         -Schema "${Prefix}_Description" -Display 'Description' -MaxLength 2000)
Add-Attribute -EntitySchema "${Prefix}_Hotel" -Attribute (New-MultiSelectAttribute  -Schema "${Prefix}_Amenities"   -Display 'Amenities'   -Options @('Wifi','Parking','Pool','Gym','Restaurant','Spa','Bar','Pet friendly') -StartValue $PrefixOption)

Write-Host "  ${Prefix}_Room"
Add-Attribute -EntitySchema "${Prefix}_Room" -Attribute (New-PicklistAttribute -Schema "${Prefix}_Type"              -Display 'Type'              -Options @('Single','Double','Twin','Suite','Family') -StartValue ($PrefixOption + 100))
Add-Attribute -EntitySchema "${Prefix}_Room" -Attribute (New-IntegerAttribute  -Schema "${Prefix}_Capacity"          -Display 'Capacity'          -Min 1 -Max 8)
Add-Attribute -EntitySchema "${Prefix}_Room" -Attribute (New-MoneyAttribute    -Schema "${Prefix}_Pricepernight"     -Display 'Price per night')
Add-Attribute -EntitySchema "${Prefix}_Room" -Attribute (New-IntegerAttribute  -Schema "${Prefix}_Quantityavailable" -Display 'Quantity available' -Min 0 -Max 999)

Write-Host "  ${Prefix}_Guest"
Add-Attribute -EntitySchema "${Prefix}_Guest" -Attribute (New-StringAttribute -Schema "${Prefix}_Email"         -Display 'Email'         -MaxLength 100 -Format 'Email')
Add-Attribute -EntitySchema "${Prefix}_Guest" -Attribute (New-StringAttribute -Schema "${Prefix}_Phone"         -Display 'Phone'         -MaxLength 30  -Format 'Phone')
Add-Attribute -EntitySchema "${Prefix}_Guest" -Attribute (New-StringAttribute -Schema "${Prefix}_Loyaltynumber" -Display 'Loyalty number' -MaxLength 30)

Write-Host "  ${Prefix}_Reservation"
# Note: the primary name (Confirmation code) was created as a plain string in
# pass 1. To make it an auto-number, we update its AutoNumberFormat below.
Add-Attribute -EntitySchema "${Prefix}_Reservation" -Attribute (New-DateAttribute     -Schema "${Prefix}_Checkindate"     -Display 'Check-in date')
Add-Attribute -EntitySchema "${Prefix}_Reservation" -Attribute (New-DateAttribute     -Schema "${Prefix}_Checkoutdate"    -Display 'Check-out date')
Add-Attribute -EntitySchema "${Prefix}_Reservation" -Attribute (New-PicklistAttribute -Schema "${Prefix}_Status"          -Display 'Status' -Options @('Pending','Confirmed','Cancelled','Completed') -StartValue ($PrefixOption + 200))
Add-Attribute -EntitySchema "${Prefix}_Reservation" -Attribute (New-MemoAttribute     -Schema "${Prefix}_Specialrequests" -Display 'Special requests' -MaxLength 1000)

# Convert confirmationcode primary name into an auto-number column.
Write-Host "  ↻ Setting ${Prefix}_Confirmationcode as auto-number" -ForegroundColor DarkCyan
$autoNumberPatch = @{
  '@odata.type'    = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
  AutoNumberFormat = 'RES-{SEQNUM:6}'
}
try {
  Invoke-Dataverse -Method PUT `
    -Path "EntityDefinitions(LogicalName='$($Prefix.ToLower())_reservation')/Attributes(LogicalName='$($Prefix.ToLower())_confirmationcode')" `
    -Body $autoNumberPatch `
    -ExtraHeaders @{ 'MSCRM.SolutionUniqueName' = $SolutionName } | Out-Null
  Write-Host "    ✓ Auto-number format set" -ForegroundColor Green
} catch {
  Write-Host "    ! Could not set auto-number (you may need to set it manually in the maker portal)" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# PASS 3: LOOKUPS
# ---------------------------------------------------------------------------

Write-Host "`n→ Creating lookup relationships…" -ForegroundColor Cyan

# Hotel.City (many hotels per city)
Add-Lookup -ChildEntity "${Prefix}_Hotel" -ParentEntity "${Prefix}_City" `
           -LookupSchema "${Prefix}_City" -LookupDisplay 'City' `
           -RelationshipSchema "${Prefix}_City_${Prefix}_Hotel"

# Room.Hotel (many rooms per hotel)
Add-Lookup -ChildEntity "${Prefix}_Room" -ParentEntity "${Prefix}_Hotel" `
           -LookupSchema "${Prefix}_Hotel" -LookupDisplay 'Hotel' `
           -RelationshipSchema "${Prefix}_Hotel_${Prefix}_Room"

# Reservation.Guest
Add-Lookup -ChildEntity "${Prefix}_Reservation" -ParentEntity "${Prefix}_Guest" `
           -LookupSchema "${Prefix}_Guest" -LookupDisplay 'Guest' `
           -RelationshipSchema "${Prefix}_Guest_${Prefix}_Reservation"

# Reservation.Hotel
Add-Lookup -ChildEntity "${Prefix}_Reservation" -ParentEntity "${Prefix}_Hotel" `
           -LookupSchema "${Prefix}_Hotel" -LookupDisplay 'Hotel' `
           -RelationshipSchema "${Prefix}_Hotel_${Prefix}_Reservation"

# Reservation.Room
Add-Lookup -ChildEntity "${Prefix}_Reservation" -ParentEntity "${Prefix}_Room" `
           -LookupSchema "${Prefix}_Room" -LookupDisplay 'Room' `
           -RelationshipSchema "${Prefix}_Room_${Prefix}_Reservation"

# ---------------------------------------------------------------------------
# DONE
# ---------------------------------------------------------------------------

Write-Host "`n✓ Provisioning complete." -ForegroundColor Green
Write-Host @"

Next steps:
  1. Verify in https://make.powerapps.com → Solutions → Travel Assistant
     that all 5 tables are present with expected columns.
  2. Import seed data (Tables → … → Import → from Excel) in this order:
       seed-cities.csv   → ${Prefix}_cities
       seed-hotels.csv   → ${Prefix}_hotels   (resolve ${Prefix}_city lookup by slug)
       seed-rooms.csv    → ${Prefix}_rooms    (resolve ${Prefix}_hotel lookup by name)
       seed-guests.csv   → ${Prefix}_guests
  3. Build the 4 Power Automate flows per flows/HOTEL-FLOWS-DESIGN.md.

"@ -ForegroundColor Cyan
