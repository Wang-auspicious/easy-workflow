# Pi message renderer

Source: `@earendil-works/pi-web-ui@0.75.3`, published by Mario Zechner, MIT.
Package: https://www.npmjs.com/package/@earendil-works/pi-web-ui/v/0.75.3
License: https://github.com/badlogic/pi-mono/blob/main/LICENSE

Vendored from the package's dist: MessageList.js, Messages.js, ThinkingBlock.js,
message-renderer-registry.js, utils/format.js. Keep LICENSE with distributions.

Easy Workflow adaptations: streaming message identity in MessageList; lightweight attachment
labels in UserMessage; accessible, localized thinking toggle; local i18n and
collapsed Easy Workflow tool renderer. PiBlocks supplies sanitized Markdown and plain code
blocks. A ShadowRoot scopes the sidebar stylesheet. The actual Pi 1.1 message
events are recorded and replayed in order; the older UI package does not bring an
older agent runtime, provider settings, session server, or Office parsers into Easy Workflow.

Also evaluated https://github.com/agegr/pi-web, a full Next.js Pi client sharing
terminal configuration and sessions. Its full navigation/server architecture is
unnecessary for the existing Easy Workflow sidebar. Easy Workflow keeps its own dispatcher conversation;
this is message-component reuse, not a terminal-session importer.
