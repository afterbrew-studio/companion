import { FlaskIcon, IconButton, Tooltip } from '@companion/ui';
import { defineSlots } from '@companion/core/client';

/**
 * The Skills page (module-operate) exposes a per-skill `skills.item-actions`
 * slot; playground drops its dry-run entry point there — inversion of control,
 * so operate never imports playground and the button simply vanishes when this
 * module is disabled. It deep-links into the Agent Lab with the skill
 * preselected: one test surface, no duplicated run UI.
 */
function DryRunSkillButton(props: Record<string, unknown>): JSX.Element | null {
  const skill = typeof props.skill === 'string' ? props.skill : null;
  if (!skill) return null;
  return (
    <Tooltip content="Dry-run in the Agent Lab — read-only, nothing is applied">
      <IconButton
        label={`Dry-run skill ${skill}`}
        onClick={() => {
          location.hash = `#/playground?skill=${encodeURIComponent(skill)}`;
        }}
      >
        <FlaskIcon />
      </IconButton>
    </Tooltip>
  );
}

export const slots = defineSlots([
  {
    slot: 'skills.item-actions',
    key: 'playground-dry-run',
    order: 0,
    permission: 'playground:run',
    component: DryRunSkillButton,
  },
]);
