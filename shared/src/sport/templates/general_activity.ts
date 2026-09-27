import { buildTemplate } from './base.js';
import { getTemplateSeed } from './catalog.js';

export const general_activity = buildTemplate(
  getTemplateSeed('general_activity'),
);
