import { BoxState } from '../../box/enums/box-state.enum'

export const GIB = 1024 * 1024 * 1024

/** States a box reaches once it no longer occupies capacity, so no overview counts them. */
export const INACTIVE_BOX_STATES = [BoxState.DESTROYED, BoxState.ARCHIVED]

export const isoTimestamp = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)

/** Newest of the given instants, or null when every one of them is absent. */
export const latestDate = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((latest, value) => (!value || (latest && latest >= value) ? latest : value), null)
