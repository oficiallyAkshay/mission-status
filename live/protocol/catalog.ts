// The component catalog "mission-status/v1": names, levels, the shared status words, and saved templates.
// WS3 writes each component's Zod schema and Lit element in live/catalog/; WS2 registers them. Version 1.
//
// A2UI v1.0 catalogs do not import one another. So "mission-status/v1" re-exports the basic catalog components we use
// (listed in BASIC) under its own id, and WS2 registers this one catalog with the MessageProcessor.

export const BASIC = ['Text', 'Icon', 'Row', 'Column', 'List', 'Card', 'Tabs', 'Divider', 'Modal', 'Button', 'CheckBox'] as const
export const ATOMS = ['StatusIcon', 'Timer', 'Count', 'Sparkline', 'Chip'] as const
export const MOLECULES = ['ChecklistItem', 'HypothesisRow', 'DecisionRow', 'CheckRow', 'TimelineEntry'] as const
export const ORGANISMS = [
  'StageCard', 'LiveTable', 'CellGrid', 'ReviewWaves', 'SeriesStepper', 'Chart', 'PRCard',
  // Checklist, Hypotheses and DecisionRows are organisms built from their molecules.
  'Checklist', 'Hypotheses', 'DecisionRows',
] as const

export type ComponentName =
  | (typeof BASIC)[number] | (typeof ATOMS)[number] | (typeof MOLECULES)[number] | (typeof ORGANISMS)[number]

// Status words every component shares, so one StatusIcon reads everywhere.
export type Status = 'open' | 'done' | 'running' | 'waiting' | 'next' | 'failed' | 'needs-you' | 'ruled-out'

// The current pane's words, mapped once here (WS5 uses this; nobody else maps).
export const PANE_STATUS: Record<string, Status> = {
  done: 'done', now: 'running', next: 'next', failed: 'failed', needs: 'needs-you',
  open: 'open', testing: 'running', 'ruled out': 'ruled-out', confirmed: 'done',
  blocked: 'waiting',
}

// Each component module in live/catalog/ exports this beside its A2UI catalog entry.
export interface CatalogEntryMeta {
  name: ComponentName
  level: 'basic' | 'atom' | 'molecule' | 'organism'
  // One sentence for the writer prompt: what the component is for, when to pick it.
  purpose: string
}

// A saved composition: a subtree of catalog components stored by name and reused. Data bindings inside it use A2UI
// relative paths, resolved against the outcome the template is drawn for (no invented slot syntax).
export interface Template {
  name: string // e.g. "ci-runtime-table"
  level: 'molecule' | 'organism'
  rootId: string
  components: unknown[] // A2UI component objects; ids are local to the template
  madeBy: 'decider' | 'model' | 'person'
  madeAt: number
  // How many times it has been used; the writer prompt lists the most used first.
  uses: number
}

// The service owns the template store (WS1 stores, WS2 decides what to save). One JSON file per template under the
// service's state folder, 0700.
export interface TemplateStore {
  list(): Promise<Template[]>
  get(name: string): Promise<Template | null>
  // Refused when any component is not in the catalog or fails its schema.
  save(t: Template): Promise<{ ok: true } | { ok: false; error: string }>
}
