// Per-pharmacy interface switches. The platform administrator can switch a large
// redesign off for one pharmacy without a new release. An absent flag always
// means "use the current interface", so adding a flag never changes anything by
// itself.

export const INTERFACE_FLAGS = {
  classicNavigation: 'classic_navigation',
}

export const isInterfaceFlagOn = (organization, flag) =>
  organization?.interface_flags?.[flag] === true

// "Classic" keeps the menu as a single list that slides in from the menu button
// (no grouped/foldable sidebar, no slim rail, no phone bottom bar).
export const usesClassicNavigation = (organization) =>
  isInterfaceFlagOn(organization, INTERFACE_FLAGS.classicNavigation)
