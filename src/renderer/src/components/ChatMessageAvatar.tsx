import React from 'react';
import type { ChatAvatarFace, ChatAvatarSender } from '../../../shared/userAvatar';

export function ChatMessageAvatar(props: {
  sender: ChatAvatarSender;
  face: ChatAvatarFace;
  omitted?: boolean;
  label: string;
}): React.JSX.Element {
  const { sender, face, omitted, label } = props;
  return (
    <div
      className={`chat-msg-avatar is-${face.shape}${omitted ? ' is-omitted' : ''}`}
      data-avatar-sender={sender}
      data-avatar-face={face.type}
      data-avatar-omitted={omitted ? '1' : undefined}
      aria-hidden={omitted || undefined}
      title={omitted ? undefined : label}
    >
      {omitted ? null : face.type === 'image' ? (
        <img className="chat-msg-avatar-img" src={face.value} alt="" draggable={false} />
      ) : (
        <span className="chat-msg-avatar-glyph">{face.value}</span>
      )}
    </div>
  );
}
