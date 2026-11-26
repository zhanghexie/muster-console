import { defineRecordApp, type AgentAppDefinition } from './agentApps';

/** Installable example: ordinary custom app, with workspace-local image assets. */
export function photoAlbumExample(): AgentAppDefinition {
  return defineRecordApp({ id: 'example-photo-album', name: '相册', icon: '▧', description: '保存和查看图片', titleField: 'title', fields: [
    { id: 'title', label: '名称', type: 'text', required: true },
    { id: 'image', label: '图片', type: 'image', required: true },
    { id: 'takenAt', label: '时间', type: 'datetime' },
    { id: 'note', label: '备注', type: 'multiline' }
  ] });
}
