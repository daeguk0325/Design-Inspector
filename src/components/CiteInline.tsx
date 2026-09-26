import { citationDisplayNumber, citationLocation, citationName } from './messageAttachments.ts';
import type { CitationSnapshot } from '../state/models.ts';
import { parseCitationMarkers, type MessageSegment } from '../citationMarker.ts';

/**
 * One component reference, rendered where the user wrote it.
 *
 * There is no tag row under a user bubble any more: the sentence is the record
 * of what was asked about, and a reference that sits in the middle of a clause
 * says more than a list at the bottom of the bubble does.
 */
export function CiteInline({ citation }: { citation: CitationSnapshot }) {
  const number = citationDisplayNumber(citation);
  const name = citationName(citation);
  const location = citationLocation(citation);
  return (
    <span
      className="cite-inline"
      data-number={number ?? ''}
      title={`${number === null ? '' : `#${number} `}${name} · ${location}`}
    >
      {number !== null && <span className="cite-inline-num">{number}</span>}
      <span className="cite-inline-name">{name}</span>
    </span>
  );
}

/**
 * The user's own sentence, with every reference turned back into a chip.
 *
 * A marker whose number is not one of this message's citations is left as the
 * text the user typed. Silently dropping it would make the transcript disagree
 * with what was sent, and swallowing a hand-typed `({3})` would lose it.
 */
export function UserText({ message }: { message: { content: string; citations: readonly CitationSnapshot[] } }) {
  const segments = parseCitationMarkers(message.content);
  if (segments.length === 0) return <span className="user-text">{message.content}</span>;
  const byNumber = new Map<number, CitationSnapshot>();
  for (const citation of message.citations) {
    const number = citationDisplayNumber(citation);
    if (number !== null) byNumber.set(number, citation);
  }
  return (
    <span className="user-text">
      {segments.map((segment: MessageSegment, index: number) => {
        if (segment.kind === 'text') return segment.text;
        const citation = byNumber.get(segment.number);
        return citation
          ? <CiteInline key={index} citation={citation} />
          : <span key={index}>{segment.raw}</span>;
      })}
    </span>
  );
}
