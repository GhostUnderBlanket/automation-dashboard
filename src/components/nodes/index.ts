import { TriggerNode }    from './TriggerNode';
import { RestNode }       from './RestNode';
import { ScriptNode }     from './ScriptNode';
import { ConditionNode }  from './ConditionNode';
import { FileNode }       from './FileNode';
import { OpenUrlNode }    from './OpenUrlNode';
import { LoopNode }       from './LoopNode';
import { LaunchAppNode }  from './LaunchAppNode';

export const nodeTypes = {
  trigger:   TriggerNode,
  rest:      RestNode,
  script:    ScriptNode,
  condition: ConditionNode,
  file:      FileNode,
  openurl:   OpenUrlNode,
  loop:      LoopNode,
  launchapp: LaunchAppNode,
} as const;
