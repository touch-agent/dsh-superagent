/** Runs the shared adapter conformance suite against the Feishu Source. */
import { describeConformance } from './suite.ts'
import { feishuConformance } from './feishu.ts'

describeConformance(feishuConformance())