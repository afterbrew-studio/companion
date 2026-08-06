import { defineSlots } from '@moxxy/companion-sdk/client';
import type { JiraSubjectKind } from '../contract/index.js';
import { JiraLinks } from './JiraLinks.js';

function WorkItemLinks(props: Record<string, unknown>): JSX.Element | null {
  const kind = props.kind;
  const repo = props.repo;
  const number = props.number;
  if ((kind !== 'issue' && kind !== 'pull-request') || typeof repo !== 'string' || typeof number !== 'number') {
    return null;
  }
  return <JiraLinks subject={{ kind: kind as JiraSubjectKind, repo, number }} />;
}

export const slots = defineSlots([
  {
    slot: 'work-item.links',
    key: 'jira-links',
    order: 10,
    permission: 'jira:read',
    component: WorkItemLinks,
  },
]);
