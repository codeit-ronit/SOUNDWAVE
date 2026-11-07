// Reducer contains no I/O, random IDs, media or authentication decisions.
export const MAX_UPCOMING = 50;
export const MAX_HISTORY = 20;
export const EMPTY_QUEUE = Object.freeze({
  current: null,
  upcoming: [],
  history: [],
});
export function queueEntry(story, chapter, id = crypto.randomUUID()) {
  return { id, story, chapter };
}
export function queueReducer(state, action) {
  switch (action.type) {
    case "replace":
      return {
        current: action.current,
        upcoming: action.upcoming.slice(0, MAX_UPCOMING),
        history: (action.history || []).slice(-MAX_HISTORY),
      };
    case "enqueue": {
      if (state.upcoming.length + action.entries.length > MAX_UPCOMING)
        return state;
      const ids = new Set(
        [state.current, ...state.upcoming, ...state.history]
          .filter(Boolean)
          .map((e) => e.id),
      );
      if (action.entries.some((e) => ids.has(e.id) || !ids.add(e.id)))
        return state;
      return {
        ...state,
        upcoming: action.next
          ? [...action.entries, ...state.upcoming]
          : [...state.upcoming, ...action.entries],
      };
    }
    case "next":
      if (!state.upcoming.length) return state;
      return {
        current: state.upcoming[0],
        upcoming: state.upcoming.slice(1),
        history: [
          ...state.history,
          ...(state.current ? [state.current] : []),
        ].slice(-MAX_HISTORY),
      };
    case "previous":
      if (!state.history.length || state.upcoming.length >= MAX_UPCOMING)
        return state;
      return {
        current: state.history.at(-1),
        history: state.history.slice(0, -1),
        upcoming: [
          ...(state.current ? [state.current] : []),
          ...state.upcoming,
        ],
      };
    case "remove":
      return {
        ...state,
        upcoming: state.upcoming.filter((e) => e.id !== action.id),
      };
    case "move": {
      const from = state.upcoming.findIndex((e) => e.id === action.id),
        to = from + action.delta;
      if (
        from < 0 ||
        ![-1, 1].includes(action.delta) ||
        to < 0 ||
        to >= state.upcoming.length
      )
        return state;
      const upcoming = [...state.upcoming];
      [upcoming[from], upcoming[to]] = [upcoming[to], upcoming[from]];
      return { ...state, upcoming };
    }
    case "clear":
      return { ...state, upcoming: [] };
    default:
      return state;
  }
}
