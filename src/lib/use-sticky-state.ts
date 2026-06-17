/**
 * `useState` that mirrors itself into `localStorage` so the value survives
 * page reloads. 
 *
 *   1. Optional Zod schema. localStorage is a system boundary — the stored
 *      payload could be from an older app version with a different shape,
 *      or hand-edited. Validating on read with a schema lets us drop a
 *      bad value cleanly to the default rather than handing garbage to
 *      React.
 *   2. Cross-tab sync via the `storage` event. If the user has the app
 *      open in two tabs, edits in one show up in the other instead of
 *      silently diverging until a reload.
 *   3. Lazy default + functional setter, matching `useState`'s API so it
 *      drops in without surprises.
 *
 * Errors from `localStorage` (quota exceeded, blocked in private mode)
 * are swallowed — persistence is best-effort, not load-bearing.
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { ZodType } from "zod";

interface UseStickyStateOptions<T> {
  /**
   * Validates the parsed JSON before adopting it. On failure, the default
   * is used and the bad entry is left in storage untouched (so the user
   * can recover it with devtools if they really want to). Skip the schema
   * for trivially-typed values like primitives where validation noise
   * outweighs the safety.
   */
  schema?: ZodType<T>;
  syncFromOtherTabs?: boolean;
}

export function useStickyState<T>(
  key: string,
  defaultValue: T | (() => T),
  options: UseStickyStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { schema, syncFromOtherTabs = false } = options;

  const [value, setValue] = useState<T>(() =>
    readSticky(key, defaultValue, schema),
  );

  useEffect(
    function persist() {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Quota exceeded / private browsing — accept that this write is lost.
      }
    },
    [key, value],
  );

  useEffect(
    function readSyncFromOtherTabs() {
      if (!syncFromOtherTabs) {
        return;
      }
      function onStorage(event: StorageEvent) {
        if (event.key !== key || event.newValue === null) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(event.newValue);
          if (schema) {
            const result = schema.safeParse(parsed);
            if (result.success) {
              setValue(result.data);
            }
            return;
          }
          setValue(parsed as T);
        } catch {
          // Malformed JSON in the storage event — ignore.
        }
      }
      globalThis.addEventListener("storage", onStorage);
      return () => {
        globalThis.removeEventListener("storage", onStorage);
      };
    },
    [key, schema, syncFromOtherTabs],
  );

  return [value, setValue] as const;
}

function readSticky<T>(
  key: string,
  defaultValue: T | (() => T),
  schema: ZodType<T> | undefined,
): T {
  const computeFallback = (): T =>
    typeof defaultValue === "function"
      ? (defaultValue as () => T)()
      : defaultValue;

  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return computeFallback();
    }
    const parsed: unknown = JSON.parse(raw);
    if (schema) {
      const result = schema.safeParse(parsed);
      return result.success ? result.data : computeFallback();
    }

    return parsed as T;
  } catch {
    return computeFallback();
  }
}
