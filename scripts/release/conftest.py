import sys
from pathlib import Path

# Make `import cicd.<module>` work when pytest runs from the repo root or here.
sys.path.insert(0, str(Path(__file__).resolve().parent))
