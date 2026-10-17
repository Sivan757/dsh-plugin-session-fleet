/**
 * The JSONL persistence plugin as a Cordis plugin value.
 *
 * The package moved its plugin from the module default export to a named `apply` between host
 * 0.2.0-rc.2 and 0.2.1-rc.2, and a bare default import is `undefined` on the newer line. This
 * helper accepts either shape so one suite pins both release lines the support window names.
 */
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'

/** Cordis plugin value for the JSONL session persistence service. */
export const jsonlPersistencePlugin = (persistence as { default?: unknown }).default ?? persistence
