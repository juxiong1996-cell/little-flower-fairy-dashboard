export function liveProgress(state, account = state.account) {
  return { account, source: 'live', basis: state.basis ?? 'official-api', at: state.at ?? new Date().toISOString(),
    signedCount: state.signedDays.length, totalDays: state.totalDays, today: state.today,
    todaySigned: state.signedDays.includes(state.today), season: state.season };
}
