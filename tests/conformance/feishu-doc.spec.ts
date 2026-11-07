/** Runs the shared adapter conformance suite against the Feishu document Source. */
import { describeConformance } from './suite.ts'
import { feishuDocConformance } from './feishu-doc.ts'

describeConformance(feishuDocConformance())
