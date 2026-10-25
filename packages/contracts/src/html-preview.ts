import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

export const HtmlPreviewSettingsRequestSchema = Type.Object(
  {
    trustedResourceOrigins: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);
export const HtmlPreviewSettingsSchema = Type.Object(
  { apiVersion: Type.Literal('v1'), ...HtmlPreviewSettingsRequestSchema.properties },
  { additionalProperties: false, $id: 'HtmlPreviewSettings' },
);
export type HtmlPreviewSettings = Static<typeof HtmlPreviewSettingsSchema>;
export type HtmlPreviewSettingsRequest = Static<typeof HtmlPreviewSettingsRequestSchema>;
export function isHtmlPreviewSettings(value: unknown): value is HtmlPreviewSettings {
  return Check(HtmlPreviewSettingsSchema, value);
}
