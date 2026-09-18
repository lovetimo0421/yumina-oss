<div v-pre>

# Macros

Macros are `{{placeholder}}` tokens in entry content that get replaced at runtime. They work in all entry types across all sections.

## Built-In Macros

### Identity
| Macro | Replaced With |
|-------|--------------|
| `{{char}}` | Character name (from world settings) |
| `{{user}}` | Player name (persona-aware: active persona name → account username → "Player") |

### Persona
| Macro | Replaced With |
|-------|--------------|
| `{{persona}}` | All persona fields combined |
| `{{persona_name}}` | Active persona's name |
| `{{persona_appearance}}` | Active persona's appearance description |
| `{{persona_personality}}` | Active persona's personality description |
| `{{persona_backstory}}` | Active persona's backstory |

### Time
| Macro | Replaced With |
|-------|--------------|
| `{{time}}` | Current time (HH:MM format) |
| `{{date}}` | Current date (human-readable) |
| `{{weekday}}` | Current day of the week |
| `{{isodate}}` | ISO 8601 date |
| `{{isotime}}` | ISO 8601 time |
| `{{idle}}` | Time since last player message (human-readable, e.g., "5 minutes") |

### Game State
| Macro | Replaced With |
|-------|--------------|
| `{{turnCount}}` | Current turn number |
| `{{model}}` | Current LLM model ID |
| `{{lastMessage}}` | Content of the most recent message |
| `{{lastUserMessage}}` | Content of the most recent player message |
| `{{lastCharMessage}}` | Content of the most recent AI message |

### Randomization
| Macro | Replaced With |
|-------|--------------|
| `{{random::a::b::c}}` | Random selection from the options (re-rolls each turn) |
| `{{pick::a::b::c}}` | Deterministic selection (seeded, stable within a turn) |
| `{{roll::NdS}}` | Dice roll result, e.g., `{{roll::2d6+1}}` |

### Utility
| Macro | Replaced With |
|-------|--------------|
| `{{// comment}}` | Removed (invisible comments in entries) |
| `{{trim}}` | Collapses surrounding whitespace |

### Variable Macros

Any variable ID works as a macro:

```
{{health}} → current value of the "health" variable
{{location}} → current value of the "location" variable
{{inventory}} → JSON.stringify of the "inventory" variable
```

If the macro doesn't match any built-in name or variable ID, it's left as-is (literal `{{unknown}}`).

</div>
