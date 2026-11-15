const ADDRESS = /^uain1[a-f0-9]{40}$/;
/** A selection owns its results; changing a filter invalidates both late data and errors. */
export function createTradeListingsReader(fetchList, publish) {
  let generation = 0,
    disposed = false;
  const reset = () => {
    generation++;
    if (!disposed) publish({ data: null, error: '', loading: true });
  };
  return {
    invalidate: reset,
    dispose() {
      disposed = true;
      generation++;
    },
    async load({
      provider = null,
      page = 1,
      search = '',
      settledSearch = search,
    }) {
      if (disposed) return;
      reset();
      const current = generation;
      if (search !== settledSearch) return;
      try {
        if (
          provider !== null &&
          (typeof provider !== 'string' || !ADDRESS.test(provider))
        )
          throw Error('Invalid Trade provider.');
        const query = new URLSearchParams({
          page: String(page),
          pageSize: '20',
          search: search.trim(),
        });
        if (provider) query.set('owner', provider);
        const data = await fetchList('/api/trade/offers?' + query);
        if (
          !Array.isArray(data?.offers) ||
          (provider && data.offers.some((offer) => offer?.owner !== provider))
        )
          throw Error('Trade listings did not match the requested provider.');
        if (!disposed && generation === current)
          publish({ data, error: '', loading: false });
      } catch (error) {
        if (!disposed && generation === current)
          publish({
            data: null,
            error: error.message || 'Trade listings are unavailable.',
            loading: false,
          });
      }
    },
  };
}
