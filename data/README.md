# Synthetic demonstration data

`demo.csv` has 730 synthetic UTC daily demand observations beginning 2024-01-01. `generate_demo.py` uses NumPy seed 42 and a gradual trend, weekly and annual sinusoids, and Gaussian noise. It contains no user data. Recreate it with the model environment's Python:

```sh
.venv/bin/python data/generate_demo.py
```

`config.json` is the complete experiment configuration. `demo-result.json` is the real Python pipeline response used by the read-only dashboard demo. The frozen evaluated model and preprocessing are included under `demo-artifacts/00000000-0000-4000-8000-000000000001/`; its manifest records the execution environment, splits and file checksums. Re-running training may alter execution timestamps and floating-point results on other platforms.

The demonstration selected ridge using tuning data only. Its held-out rolling-origin MAE is about 2.471, RMSE 3.072, sMAPE 2.044%, MASE 0.829 and interval coverage 85.16% against nominal 90%. These numbers demonstrate the workflow, not expected performance on unseen real datasets. The MLP is trained and evaluated as a candidate even when a simpler model wins.
