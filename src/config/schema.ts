import { z } from 'zod';
import { normalizeJenkinsBaseUrl } from '../utils/url';

export const JENKINS_AUTH_MODES = ['none', 'apiToken', 'password'] as const;
export type JenkinsAuthMode = (typeof JENKINS_AUTH_MODES)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => normalizeJenkinsBaseUrl(value))
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

export const jenkinsInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    baseUrl: httpUrlSchema,
    authMode: z.enum(JENKINS_AUTH_MODES),
    username: z.string().trim().optional(),
    verifyTls: z.boolean(),
    readOnly: z.boolean().default(false),
    allowBackgroundAccess: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strip();

export type JenkinsInstanceConfig = z.infer<typeof jenkinsInstanceConfigSchema>;
export const jenkinsInstanceConfigListSchema = z.array(jenkinsInstanceConfigSchema);

export function parseJenkinsInstanceConfig(value: unknown): JenkinsInstanceConfig {
  return jenkinsInstanceConfigSchema.parse(value);
}

export function parseJenkinsInstanceConfigList(value: unknown): JenkinsInstanceConfig[] {
  return jenkinsInstanceConfigListSchema.parse(value);
}
