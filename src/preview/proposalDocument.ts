/**
 * The proposal document.
 *
 * Built deterministically from the accepted change log, not written by the
 * model. The document is meant to be handed to a person or an agent who will
 * implement the change, so every value in it has to be one that was actually
 * measured and actually applied. A model-authored version could round a value,
 * reorder a property, or describe a change that was rejected; none of those
 * are acceptable in an artifact whose whole purpose is to be executed.
 *
 * Rejected proposals are listed too, in a short section: an implementer who
 * reads the log should know which directions were already turned down, or they
 * will propose them again.
 */

import type { InspectorSession } from '../state/models.ts';
import { latestUserRequest } from '../state/models.ts';
import type { ChangeLogGroup, Proposal } from './proposal.ts';
import { changeLogGroupsForSession, proposalsIn } from './proposal.ts';

export const PROPOSAL_DOCUMENT_TITLE = 'UI 수정 제안서';
const LINE_ENDING = '\n';
const MAX_COMPONENT_CHARS = 120;

function sanitize(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function groupSection(group: ChangeLogGroup): string[] {
  const out: string[] = [`### ${sanitize(group.component, MAX_COMPONENT_CHARS)}`, ''];
  out.push('| 속성 | 변경 전 (측정값) | 변경 후 |');
  out.push('| --- | --- | --- |');
  for (const entry of group.entries) {
    // An unmeasured "before" is stated as unknown rather than guessed. Writing
    // a plausible default here is exactly the fabrication this document exists
    // to avoid.
    const before = entry.before === null ? '(측정 없음)' : `\`${entry.before}\``;
    out.push(`| \`${entry.property}\` | ${before} | \`${entry.after}\` |`);
  }
  out.push('');
  return out;
}

export interface ProposalDocument {
  title: string;
  markdown: string;
  /** Components with at least one accepted change. */
  componentCount: number;
  changeCount: number;
  rejectedCount: number;
}

export function buildProposalDocument(session: InspectorSession | null): ProposalDocument {
  const groups = changeLogGroupsForSession(session);
  const proposals = proposalsIn(session?.messages ?? [], session?.previewTransactions ?? []);
  const rejected = proposals.filter((proposal) => proposal.state === 'rejected');
  const changeCount = groups.reduce((total, group) => total + group.entries.length, 0);
  const request = session === null ? '' : latestUserRequest(session);

  const out: string[] = [`# ${PROPOSAL_DOCUMENT_TITLE}`, ''];
  out.push('## 목적');
  out.push(request === '' ? '(원본 요청 없음)' : sanitize(request, 1_000), '');

  if (groups.length === 0) {
    out.push('## 변경 내역');
    out.push('(승인된 변경 없음)', '');
  } else {
    out.push('## 변경 내역');
    out.push(
      '아래 값은 검수 시점에 실제로 측정된 값이며, 미리보기에서 실제 적용된 값입니다.',
      '',
    );
    for (const group of groups) out.push(...groupSection(group));
  }

  if (rejected.length > 0) {
    out.push('## 반영하지 않은 방향');
    out.push('아래는 검토 후 제외된 변경입니다. 같은 방향으로 재 제안하지 않습니다.', '');
    for (const proposal of rejected) {
      for (const line of summaryFor(proposal)) out.push(`- ${line}`);
    }
    out.push('');
  }

  out.push('## 구현 시 확인 사항');
  for (const item of checkItems(groups)) out.push(`- ${item}`);
  out.push('');

  return {
    title: PROPOSAL_DOCUMENT_TITLE,
    markdown: out.join(LINE_ENDING).replace(/\n+$/, '\n'),
    componentCount: groups.length,
    changeCount,
    rejectedCount: rejected.length,
  };
}

function summaryFor(proposal: Proposal): string[] {
  return proposal.changes.map((change) => {
    const name = change.anchor.testId || change.anchor.id || change.anchor.tagName;
    const declarations = Object.entries(change.declarations)
      .map(([property, value]) => `${property} ${value}`)
      .join(', ');
    return sanitize(`${name}: ${declarations}`, 200);
  });
}

function checkItems(groups: ChangeLogGroup[]): string[] {
  if (groups.length === 0) {
    return ['승인된 변경이 없어 구현할 항목이 없습니다.'];
  }
  const items: string[] = [];
  const properties = new Set<string>();
  for (const group of groups) for (const entry of group.entries) properties.add(entry.property);
  const unmeasured = groups.some((group) => group.entries.some((entry) => entry.before === null));
  if (unmeasured) {
    items.push('변경 전 값이 측정되지 않은 속성은 실제 코드와 대조한 뒤 확정하세요.');
  }
  for (const property of ['font-size', 'font-weight', 'color', 'background-color']) {
    if (properties.has(property)) {
      items.push('색상·서체는 접근성 대비를 확인하세요 (명도 대비 4.5:1 이상).');
      break;
    }
  }
  for (const property of ['width', 'height', 'min-width', 'max-width']) {
    if (properties.has(property)) {
      items.push('반응형 breakpoint에서 레이아웃이 깨지지 않는지 확인하세요.');
      break;
    }
  }
  if (properties.has('padding') || properties.has('padding-top') || properties.has('gap')) {
    items.push('간격 변경 시 조밀한 레이아웃과 긴 텍스트 입력 사례를 함께 확인하세요.');
  }
  if (items.length === 0) items.push('미리보기 화면과 실제 구현 결과가 동일한지 확인하세요.');
  return items;
}
