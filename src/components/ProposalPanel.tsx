import { useMemo, useState } from 'react';
import type { InspectorSession } from '../state/models.ts';
import type { ChangeLogGroup } from '../preview/proposal.ts';
import { changeLogGroupsForSession, pendingForSession } from '../preview/proposal.ts';
import { buildProposalDocument } from '../preview/proposalDocument.ts';

export interface ProposalPanelProps {
  open: boolean;
  session: InspectorSession | null;
  onClose: () => void;
  onCopy: (text: string) => void | Promise<void>;
}

/**
 * The running record of what has been changed, and the source of the proposal
 * document. Both render from the same change log, so they cannot drift: a
 * value shown here is the value the document will hand over.
 */
export function ProposalPanel({ open, session, onClose, onCopy }: ProposalPanelProps) {
  const [copied, setCopied] = useState<'log' | 'document' | null>(null);
  const groups = useMemo(() => changeLogGroupsForSession(session), [session]);
  const pending = useMemo(() => pendingForSession(session), [session]);
  const document_ = useMemo(() => buildProposalDocument(session), [session]);
  const changeCount = document_.changeCount;

  if (!open) return null;

  const flash = (which: 'log' | 'document') => {
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1_200);
  };

  return (
    <aside className="proposal-panel" aria-label="Change log">
      <header className="proposal-panel-head">
        <div>
          <h2>변경 내역</h2>
          <p className="proposal-panel-sub">
            {changeCount === 0
              ? '아직 승인된 변경이 없습니다'
              : `${document_.componentCount}개 컴포넌트 · ${changeCount}건 승인`}
            {pending.length > 0 && ` · ${pending.length}건 대기 중`}
          </p>
        </div>
        <button type="button" className="iconbtn" aria-label="Close change log" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="proposal-panel-body">
        {groups.length === 0 ? (
          <p className="proposal-empty">
            Accept를 누른 수정만 여기에 쌓입니다. 다음 요청을 보내면 대기 중인 제안은 자동으로 되돌려집니다.
          </p>
        ) : (
          groups.map((group) => <GroupBlock key={group.component} group={group} />)
        )}
      </div>

      <footer className="proposal-panel-foot">
        <button
          type="button"
          className="mini"
          disabled={changeCount === 0}
          onClick={() => {
            onCopy(plainText(groups));
            flash('log');
          }}
        >
          {copied === 'log' ? '복사됨' : '내역 복사'}
        </button>
        <button
          type="button"
          className="primary-mini"
          disabled={changeCount === 0}
          onClick={() => {
            onCopy(document_.markdown);
            flash('document');
          }}
        >
          {copied === 'document' ? '복사됨' : '제안서 복사'}
        </button>
      </footer>
    </aside>
  );
}

function GroupBlock({ group }: { group: ChangeLogGroup }) {
  return (
    <section className="proposal-group">
      <h3>{group.component}</h3>
      <ul>
        {group.entries.map((entry) => (
          <li key={`${entry.transactionId}-${entry.property}-${entry.after}`}>
            <code>{entry.property}</code>
            <span className="proposal-before">
              {entry.before === null ? '측정 없음' : entry.before}
            </span>
            <span className="proposal-arrow" aria-hidden="true">
              →
            </span>
            <code className="proposal-after">{entry.after}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function plainText(groups: ChangeLogGroup[]): string {
  const out: string[] = ['변경 내역', ''];
  for (const group of groups) {
    out.push(group.component);
    for (const entry of group.entries) {
      const before = entry.before === null ? '측정 없음' : entry.before;
      out.push(`  ${entry.property}: ${before} → ${entry.after}`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}
