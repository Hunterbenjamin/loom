#!/bin/sh
# Append a timestamped action marker: mark.sh "<text>"  (writes $TMPDIR/loom-spike-02/markers.jsonl)
python3 -c 'import json,sys,time;print(json.dumps({"t_ms":int(time.time()*1000),"mark":sys.argv[1]}))' "$1" >>"${TMPDIR}loom-spike-02/markers.jsonl"
