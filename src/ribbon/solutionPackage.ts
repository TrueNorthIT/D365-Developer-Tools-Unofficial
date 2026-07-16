import type { EntityRibbonMetadata } from '../dataverseClient';
import type { RibbonControl, RibbonModel } from './ribbonModel';
import { buildZip } from './zip';

// Builds a minimal unmanaged Dataverse solution zip carrying only a RibbonDiffXml customization for
// one entity -- the transport used by publishToDynamics (ribbonEditorPanel.ts) to actually apply a
// ribbon edit to a live environment via ImportSolution.
//
// customizations.xml's <Entity> includes a real <EntityInfo> block (see buildEntityInfoXml) -- a real
// Dataverse export of this exact "entity, do-not-include-required-components, ribbon-only" scenario
// always includes one (if attribute-less), and live evidence backs that up: without it, an import can
// report success (even `succeeded="warning"`, which Dataverse's own import history treats as
// non-fatal) yet the change doesn't durably persist -- it can vanish again shortly after. The
// entity-identifying fields in that block (name, display name, plural name, description, entity set
// name, ownership type, introduced version) are always the caller's live-fetched values
// (EntityRibbonMetadata), never invented -- an incomplete guess here risks clobbering real entity
// settings, a materially worse failure mode than "the ribbon change doesn't apply". The remaining
// ~40 boolean settings a real export also includes (audit, duplicate detection, mobile visibility,
// etc.) don't have a verified 1:1 Web API property mapping, so they use the same fixed defaults a
// real, successfully-imported custom entity actually had (captured from a live export) rather than a
// guessed mapping to a possibly-wrong property name.
//
// solution.xml's <Publisher> only needs <UniqueName> -- Dataverse resolves it to the real, existing
// publisher record with that name rather than creating a new one, so long as the caller (see
// pickPublisher in ribbonEditorPanel.ts) only ever passes a publisher that's actually already in the
// target org. Likewise its <MissingDependencies> self-reference (declaring that the real, full entity
// already exists Active in the target) matches what a real export of this same scenario emits.

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="text/xml" />
</Types>`;

export function buildRibbonSolutionZip(params: {
    entityLogicalName: string;
    entityDisplayName: string;
    entityMetadata: EntityRibbonMetadata;
    ribbonDiffXml: string;
    publisherUniqueName: string;
    solutionUniqueName: string;
    solutionFriendlyName: string;
}): Buffer {
    const entityLogicalName = escapeXml(params.entityLogicalName);
    const entityDisplayName = escapeXml(params.entityDisplayName || params.entityLogicalName);

    const solutionXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="D365DeveloperToolsUnofficial">
  <SolutionManifest>
    <UniqueName>${escapeXml(params.solutionUniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${escapeXml(params.solutionFriendlyName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>1.0.0.0</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${escapeXml(params.publisherUniqueName)}</UniqueName>
    </Publisher>
    <RootComponents>
      <RootComponent type="1" schemaName="${entityLogicalName}" behavior="1" />
    </RootComponents>
    <MissingDependencies>
      <MissingDependency>
        <Required type="1" schemaName="${entityLogicalName}" displayName="${entityDisplayName}" solution="Active" />
        <Dependent type="1" schemaName="${entityLogicalName}" displayName="${entityDisplayName}" />
      </MissingDependency>
    </MissingDependencies>
  </SolutionManifest>
</ImportExportXml>`;

    // <Entity><Name> and <EntityInfo><entity Name="..."> must be byte-identical -- confirmed by a
    // real import failure ("Not all instances of the entity name match") from using the lowercase
    // logical name here while EntityInfo correctly used the schema name. A real export uses the
    // schema-name casing (e.g. "tn_JCTesttable") in both places, not the logical name.
    const schemaName = escapeXml(params.entityMetadata.schemaName);
    const customizationsXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml>
  <Entities>
    <Entity>
      <Name LocalizedName="${entityDisplayName}" OriginalName="${entityDisplayName}">${schemaName}</Name>
      ${buildEntityInfoXml(params.entityMetadata)}
      ${params.ribbonDiffXml.trim()}
    </Entity>
  </Entities>
</ImportExportXml>`;

    return buildZip([
        { name: 'solution.xml', content: Buffer.from(solutionXml, 'utf8'), method: 0 },
        { name: 'customizations.xml', content: Buffer.from(customizationsXml, 'utf8'), method: 0 },
        { name: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: 0 },
    ]);
}

// Field values below (everything except the entity-identifying ones passed in) are copied verbatim
// from a real Dataverse export of the exact "entity, do-not-include-required-components, ribbon-only"
// scenario for a plain custom table -- see the module doc comment above for why they aren't
// individually live-fetched. schemaName is used for the <entity Name="..."> attribute specifically
// (matches a real export's casing, e.g. "tn_JCTesttable" rather than the all-lowercase logical name).
function buildEntityInfoXml(meta: EntityRibbonMetadata): string {
    const schemaName = escapeXml(meta.schemaName);
    return `<EntityInfo>
        <entity Name="${schemaName}">
          <LocalizedNames>
            <LocalizedName description="${escapeXml(meta.displayName)}" languagecode="1033" />
          </LocalizedNames>
          <LocalizedCollectionNames>
            <LocalizedCollectionName description="${escapeXml(meta.displayCollectionName)}" languagecode="1033" />
          </LocalizedCollectionNames>
          <Descriptions>
            <Description description="${escapeXml(meta.description)}" languagecode="1033" />
          </Descriptions>
          <attributes />
          <EntitySetName>${escapeXml(meta.entitySetName)}</EntitySetName>
          <IsDuplicateCheckSupported>1</IsDuplicateCheckSupported>
          <IsBusinessProcessEnabled>0</IsBusinessProcessEnabled>
          <IsRequiredOffline>0</IsRequiredOffline>
          <IsInteractionCentricEnabled>0</IsInteractionCentricEnabled>
          <IsCollaboration>0</IsCollaboration>
          <AutoRouteToOwnerQueue>0</AutoRouteToOwnerQueue>
          <IsConnectionsEnabled>0</IsConnectionsEnabled>
          <IsDocumentManagementEnabled>0</IsDocumentManagementEnabled>
          <AutoCreateAccessTeams>0</AutoCreateAccessTeams>
          <IsOneNoteIntegrationEnabled>0</IsOneNoteIntegrationEnabled>
          <IsKnowledgeManagementEnabled>0</IsKnowledgeManagementEnabled>
          <IsSLAEnabled>0</IsSLAEnabled>
          <IsDocumentRecommendationsEnabled>0</IsDocumentRecommendationsEnabled>
          <IsBPFEntity>0</IsBPFEntity>
          <OwnershipTypeMask>${escapeXml(meta.ownershipType)}</OwnershipTypeMask>
          <IsAuditEnabled>0</IsAuditEnabled>
          <IsRetrieveAuditEnabled>0</IsRetrieveAuditEnabled>
          <IsRetrieveMultipleAuditEnabled>0</IsRetrieveMultipleAuditEnabled>
          <IsActivity>0</IsActivity>
          <ActivityTypeMask></ActivityTypeMask>
          <IsActivityParty>0</IsActivityParty>
          <IsReplicated>0</IsReplicated>
          <IsReplicationUserFiltered>0</IsReplicationUserFiltered>
          <IsMailMergeEnabled>1</IsMailMergeEnabled>
          <IsVisibleInMobile>0</IsVisibleInMobile>
          <IsVisibleInMobileClient>0</IsVisibleInMobileClient>
          <IsReadOnlyInMobileClient>0</IsReadOnlyInMobileClient>
          <IsOfflineInMobileClient>0</IsOfflineInMobileClient>
          <DaysSinceRecordLastModified>0</DaysSinceRecordLastModified>
          <MobileOfflineFilters></MobileOfflineFilters>
          <IsMapiGridEnabled>1</IsMapiGridEnabled>
          <IsReadingPaneEnabled>1</IsReadingPaneEnabled>
          <IsQuickCreateEnabled>0</IsQuickCreateEnabled>
          <SyncToExternalSearchIndex>0</SyncToExternalSearchIndex>
          <IntroducedVersion>${escapeXml(meta.introducedVersion)}</IntroducedVersion>
          <IsCustomizable>1</IsCustomizable>
          <IsRenameable>1</IsRenameable>
          <IsMappable>1</IsMappable>
          <CanModifyAuditSettings>1</CanModifyAuditSettings>
          <CanModifyMobileVisibility>1</CanModifyMobileVisibility>
          <CanModifyMobileClientVisibility>1</CanModifyMobileClientVisibility>
          <CanModifyMobileClientReadOnly>1</CanModifyMobileClientReadOnly>
          <CanModifyMobileClientOffline>1</CanModifyMobileClientOffline>
          <CanModifyConnectionSettings>1</CanModifyConnectionSettings>
          <CanModifyDuplicateDetectionSettings>1</CanModifyDuplicateDetectionSettings>
          <CanModifyMailMergeSettings>1</CanModifyMailMergeSettings>
          <CanModifyQueueSettings>1</CanModifyQueueSettings>
          <CanCreateAttributes>1</CanCreateAttributes>
          <CanCreateForms>1</CanCreateForms>
          <CanCreateCharts>1</CanCreateCharts>
          <CanCreateViews>1</CanCreateViews>
          <CanModifyAdditionalSettings>1</CanModifyAdditionalSettings>
          <CanEnableSyncToExternalSearchIndex>1</CanEnableSyncToExternalSearchIndex>
          <EnforceStateTransitions>0</EnforceStateTransitions>
          <CanChangeHierarchicalRelationship>1</CanChangeHierarchicalRelationship>
          <EntityHelpUrlEnabled>0</EntityHelpUrlEnabled>
          <ChangeTrackingEnabled>0</ChangeTrackingEnabled>
          <CanChangeTrackingBeEnabled>1</CanChangeTrackingBeEnabled>
          <IsEnabledForExternalChannels>0</IsEnabledForExternalChannels>
          <IsMSTeamsIntegrationEnabled>0</IsMSTeamsIntegrationEnabled>
          <IsSolutionAware>0</IsSolutionAware>
        </entity>
      </EntityInfo>`;
}

/** Whether any node in the model has actually been touched -- used to short-circuit "Publish" with
 *  an info message instead of importing a solution that would apply an empty diff. */
export function hasRibbonChanges(model: RibbonModel): boolean {
    const controlsChanged = (controls: RibbonControl[]): boolean =>
        controls.some(c => c.status !== 'unchanged' || (c.controls && controlsChanged(c.controls)));

    const tabsChanged = model.tabs.some(tab =>
        tab.status !== 'unchanged' ||
        tab.groups.some(group => group.status !== 'unchanged' || controlsChanged(group.controls)));

    return tabsChanged
        || model.commandDefinitions.some(c => c.status !== 'unchanged')
        || model.enableRules.some(r => r.status !== 'unchanged')
        || model.displayRules.some(r => r.status !== 'unchanged');
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
