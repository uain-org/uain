/** A retired authority route is unavailable evidence, never an empty record.
 * One read per disclosure mount; no polling of retired or failing routes. */
export async function readTrackRecord<T>(url: string, fetcher: typeof fetch = fetch): Promise<
  { state: 'ready'; record: T } | { state: 'unavailable' }
> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return { state: 'unavailable' };
    const record = await response.json();
    if (!record?.summary || !record.karma_history || !record.test_results)
      return { state: 'unavailable' };
    return { state: 'ready', record };
  } catch { return { state: 'unavailable' }; }
}
