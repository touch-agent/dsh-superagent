/** Runs the shared adapter conformance suite against the GitHub Source. */
import { describeConformance } from './suite.ts'
import { githubConformance } from './github.ts'

describeConformance(githubConformance())