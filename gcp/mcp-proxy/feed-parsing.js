export function extractGenericJsonFeedEntries(data, feedId) {
  if (feedId === 'transport-opensky' && Array.isArray(data?.states)) {
    return data.states;
  }

  return Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.packages)
      ? data.packages
      : Array.isArray(data?.entries)
        ? data.entries
        : Array.isArray(data?.articles)
          ? data.articles
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.results)
              ? data.results
              : Array.isArray(data?.bills)
                ? data.bills
                : Array.isArray(data?.amendments)
                  ? data.amendments
                  : Array.isArray(data?.committeeReports)
                    ? data.committeeReports
                    : Array.isArray(data?.committeeReport)
                      ? data.committeeReport
                      : Array.isArray(data?.reports)
                        ? data.reports
                        : Array.isArray(data?.houseRollCallVotes)
                          ? data.houseRollCallVotes
                          : Array.isArray(data?.events)
                            ? data.events
                            : Array.isArray(data?.hearings)
                              ? data.hearings
                              : Array.isArray(data?.nominations)
                                ? data.nominations
                                : Array.isArray(data?.treaties)
                                  ? data.treaties
                                  : Array.isArray(data?.congressionalRecord)
                                    ? data.congressionalRecord
                                    : Array.isArray(data?.response?.data)
                                      ? data.response.data
                                      : Array.isArray(data?.response?.items)
                                        ? data.response.items
                                        : Array.isArray(data?.response?.results)
                                          ? data.response.results
                                          : [];
}
