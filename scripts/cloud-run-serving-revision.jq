[
  .status.traffic[]?
  | select(.revisionName and ((.percent // 0) > 0))
  | {revisionName, percent: (.percent // 0)}
]
| group_by(.revisionName)
| map({revisionName: .[0].revisionName, percent: (map(.percent) | add)})
| if length == 1 and .[0].percent == 100
  then .[0].revisionName
  else error("MCP service does not have exactly one revision serving 100 percent of traffic")
  end
