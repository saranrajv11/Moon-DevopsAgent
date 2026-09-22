/**
 * Turning a pull request's changed files into a deployable Salesforce package.
 *
 * This is the unit of deployment: not the whole branch, not all of force-app,
 * but exactly the components the PR touched.
 */

export interface SfComponent {
  type: string;      // metadata type, e.g. ApexClass
  fullName: string;  // member name, e.g. PaymentValidator
  path: string;      // source path the file came from
}

/**
 * Maps an SFDX source path to its metadata type and member name.
 * Order matters — the first pattern that matches wins, so more specific
 * directory patterns are listed before generic ones.
 */
const RULES: Array<{ re: RegExp; type: string; member: (m: RegExpMatchArray) => string }> = [
  // Field lives inside its object folder: objects/Account/fields/Foo__c.field-meta.xml
  { re: /objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/, type: "CustomField",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/recordTypes\/([^/]+)\.recordType-meta\.xml$/, type: "RecordType",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/, type: "ValidationRule",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/listViews\/([^/]+)\.listView-meta\.xml$/, type: "ListView",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/webLinks\/([^/]+)\.webLink-meta\.xml$/, type: "WebLink",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/compactLayouts\/([^/]+)\.compactLayout-meta\.xml$/, type: "CompactLayout",
    member: (m) => `${m[1]}.${m[2]}` },
  { re: /objects\/([^/]+)\/\1\.object-meta\.xml$/, type: "CustomObject", member: (m) => m[1]! },
  { re: /objects\/([^/]+)\//, type: "CustomObject", member: (m) => m[1]! },

  // Bundles: the whole directory is one component
  { re: /lwc\/([^/]+)\//, type: "LightningComponentBundle", member: (m) => m[1]! },
  { re: /aura\/([^/]+)\//, type: "AuraDefinitionBundle", member: (m) => m[1]! },
  { re: /experiences\/([^/]+)\//, type: "ExperienceBundle", member: (m) => m[1]! },
  { re: /waveTemplates\/([^/]+)\//, type: "WaveTemplateBundle", member: (m) => m[1]! },

  // Single-file types
  { re: /classes\/([^/]+)\.cls$/, type: "ApexClass", member: (m) => m[1]! },
  { re: /classes\/([^/]+)\.cls-meta\.xml$/, type: "ApexClass", member: (m) => m[1]! },
  { re: /triggers\/([^/]+)\.trigger$/, type: "ApexTrigger", member: (m) => m[1]! },
  { re: /triggers\/([^/]+)\.trigger-meta\.xml$/, type: "ApexTrigger", member: (m) => m[1]! },
  { re: /pages\/([^/]+)\.page$/, type: "ApexPage", member: (m) => m[1]! },
  { re: /components\/([^/]+)\.component$/, type: "ApexComponent", member: (m) => m[1]! },
  { re: /flows\/([^/]+)\.flow-meta\.xml$/, type: "Flow", member: (m) => m[1]! },
  { re: /layouts\/([^/]+)\.layout-meta\.xml$/, type: "Layout", member: (m) => m[1]! },
  { re: /permissionsets\/([^/]+)\.permissionset-meta\.xml$/, type: "PermissionSet", member: (m) => m[1]! },
  { re: /profiles\/([^/]+)\.profile-meta\.xml$/, type: "Profile", member: (m) => m[1]! },
  { re: /customMetadata\/([^/]+)\.md-meta\.xml$/, type: "CustomMetadata", member: (m) => m[1]! },
  { re: /labels\/([^/]+)\.labels-meta\.xml$/, type: "CustomLabels", member: (m) => m[1]! },
  { re: /staticresources\/([^/]+)\.resource-meta\.xml$/, type: "StaticResource", member: (m) => m[1]! },
  { re: /staticresources\/([^/]+)\.[^/.]+$/, type: "StaticResource", member: (m) => m[1]! },
  { re: /tabs\/([^/]+)\.tab-meta\.xml$/, type: "CustomTab", member: (m) => m[1]! },
  { re: /applications\/([^/]+)\.app-meta\.xml$/, type: "CustomApplication", member: (m) => m[1]! },
  { re: /flexipages\/([^/]+)\.flexipage-meta\.xml$/, type: "FlexiPage", member: (m) => m[1]! },
  { re: /queues\/([^/]+)\.queue-meta\.xml$/, type: "Queue", member: (m) => m[1]! },
  { re: /groups\/([^/]+)\.group-meta\.xml$/, type: "Group", member: (m) => m[1]! },
  { re: /namedCredentials\/([^/]+)\.namedCredential-meta\.xml$/, type: "NamedCredential", member: (m) => m[1]! },
  { re: /remoteSiteSettings\/([^/]+)\.remoteSite-meta\.xml$/, type: "RemoteSiteSetting", member: (m) => m[1]! },
  { re: /globalValueSets\/([^/]+)\.globalValueSet-meta\.xml$/, type: "GlobalValueSet", member: (m) => m[1]! },
  { re: /assignmentRules\/([^/]+)\.assignmentRules-meta\.xml$/, type: "AssignmentRules", member: (m) => m[1]! },
  { re: /sharingRules\/([^/]+)\.sharingRules-meta\.xml$/, type: "SharingRules", member: (m) => m[1]! },
  { re: /workflows\/([^/]+)\.workflow-meta\.xml$/, type: "Workflow", member: (m) => m[1]! },
  { re: /email\/([^/]+)\/([^/]+)\.email-meta\.xml$/, type: "EmailTemplate",
    member: (m) => `${m[1]}/${m[2]}` },
  { re: /reports\/([^/]+)\/([^/]+)\.report-meta\.xml$/, type: "Report",
    member: (m) => `${m[1]}/${m[2]}` },
  { re: /dashboards\/([^/]+)\/([^/]+)\.dashboard-meta\.xml$/, type: "Dashboard",
    member: (m) => `${m[1]}/${m[2]}` },
];

/** Files that are never deployable metadata. */
const IGNORE = [
  /^\.github\//, /^\.husky\//, /^docs?\//, /^scripts?\//,
  /(^|\/)(README|CHANGELOG|LICENSE)/i,
  /\.(md|txt|yml|yaml|json|lock|gitignore|forceignore|prettierrc|eslintrc)$/i,
  /(^|\/)package\.json$/, /(^|\/)jest\.config/, /__tests__\//, /\.test\.(js|ts)$/,
];

export interface ComponentExtraction {
  components: SfComponent[];
  ignored: string[];
  unrecognized: string[];
}

/**
 * Derive the deployable component set from a PR's changed file list.
 * Deleted files are excluded — destructive changes need explicit handling and
 * must never ride along silently in a promotion.
 */
export function extractComponents(
  files: Array<{ filename: string; status: string }>,
): ComponentExtraction {
  const seen = new Map<string, SfComponent>();
  const ignored: string[] = [];
  const unrecognized: string[] = [];

  for (const f of files) {
    if (f.status === "removed") {
      ignored.push(`${f.filename} (deleted — destructive changes are not auto-deployed)`);
      continue;
    }
    if (IGNORE.some((re) => re.test(f.filename))) {
      ignored.push(f.filename);
      continue;
    }

    const rule = RULES.find((r) => r.re.test(f.filename));
    if (!rule) {
      unrecognized.push(f.filename);
      continue;
    }
    const m = f.filename.match(rule.re)!;
    const comp: SfComponent = {
      type: rule.type,
      fullName: rule.member(m),
      path: f.filename,
    };
    // A bundle or object touched by several files is still one component.
    seen.set(`${comp.type}:${comp.fullName}`, comp);
  }

  return {
    components: [...seen.values()].sort((a, b) =>
      a.type === b.type ? a.fullName.localeCompare(b.fullName) : a.type.localeCompare(b.type)),
    ignored,
    unrecognized,
  };
}

/** Build a package.xml manifest for exactly these components. */
export function buildPackageXml(components: SfComponent[], apiVersion = "67.0"): string {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    const list = byType.get(c.type) ?? [];
    list.push(c.fullName);
    byType.set(c.type, list);
  }

  const types = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, members]) => {
      const rows = [...new Set(members)].sort()
        .map((m) => `        <members>${escapeXml(m)}</members>`)
        .join("\n");
      return `    <types>\n${rows}\n        <name>${type}</name>\n    </types>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
${types}
    <version>${apiVersion}</version>
</Package>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Apex classes in the set, used to scope test runs to what actually changed. */
export function apexTestClasses(components: SfComponent[]): string[] {
  return components
    .filter((c) => c.type === "ApexClass" && /Test$/i.test(c.fullName))
    .map((c) => c.fullName);
}
