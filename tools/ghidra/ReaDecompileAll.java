// Ghidra headless script: decompile many functions in a single program run.
//
// @category REA
//
// Decompiling through a per-process bridge means one import per function, which
// is unusable at scale. This script therefore runs inside one Ghidra session,
// walks the FunctionManager, and decompiles every selected function, writing
// one .c and one .asm file per procedure.
//
// Args:
//   0: inventory TSV output path (## prefixed lines: totals then one row per func)
//   1: output directory for .c/.asm files
//   2: "local" | "imported"  — which functions to include
//   3: limit (0 = no limit)

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

public class ReaDecompileAll extends GhidraScript {
	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		String tsvPath = args.length > 0 ? args[0] : "C:\\Windows\\Temp\\rea-inventory.tsv";
		String outDir = args.length > 1 ? args[1] : "C:\\Windows\\Temp\\rea-out";
		String mode = args.length > 2 ? args[2] : "local";
		int limit = args.length > 3 ? Integer.parseInt(args[3]) : 0;

		new File(outDir).mkdirs();

		DecompInterface decomp = new DecompInterface();
		DecompileOptions opts = new DecompileOptions();
		decomp.setOptions(opts);
		decomp.openProgram(currentProgram);

		FunctionManager fm = currentProgram.getFunctionManager();
		List<Function> targets = new ArrayList<>();
		int totalSeen = 0, localSeen = 0;

		// Classification relies on the PDB: with a matching .pdb beside the
		// target, imported symbols carry IMPORTED provenance and split out
		// cleanly. Without it Ghidra synthesises most imported thunks as local
		// functions, so the two passes would not reflect the real inventory.
		boolean pdbLoaded = hasImportedProvenance(fm);

		FunctionIterator it = fm.getFunctions(true);
		while (it.hasNext()) {
			Function f = it.next();
			totalSeen++;
			boolean imported = isImported(f);
			if (!imported) {
				localSeen++;
			}
			boolean want = "imported".equals(mode) ? imported : !imported;
			if (want) {
				targets.add(f);
			}
		}

		if (!pdbLoaded) {
			println("REA: WARNING - no IMPORTED symbol provenance found. Without a matching .pdb "
				+ "next to the target, imported thunks are indistinguishable from local code and "
				+ "the local/imported split is not meaningful.");
		}

		if (limit > 0 && targets.size() > limit) {
			targets = targets.subList(0, limit);
		}

		int ok = 0, failed = 0, skipped = 0;
		List<String> rows = new ArrayList<>();
		for (Function f : targets) {
			if (f.isExternal()) {
				skipped++;
				continue;
			}
			String stem = fileStem(f);
			try {
				DecompileResults res = decomp.decompileFunction(f, 120, monitor);
				if (res == null || !res.decompileCompleted() || res.getDecompiledFunction() == null) {
					rows.add(row(f, "failed", "decompile did not complete"));
					failed++;
					continue;
				}
				writeC(new File(outDir, stem + ".c"), f, res.getDecompiledFunction().getC());
				writeAsm(new File(outDir, stem + ".asm"), f);
				ok++;
				rows.add(row(f, "ok", ""));
			} catch (Exception e) {
				rows.add(row(f, "failed", clean(String.valueOf(e.getMessage()))));
				failed++;
			}
			if ((ok + failed) % 50 == 0) {
				println("REA: progress " + (ok + failed) + "/" + targets.size());
			}
		}
		decomp.dispose();

		try (PrintWriter w = new PrintWriter(new FileWriter(tsvPath))) {
			for (String line : rows) {
				w.println(line);
			}
			w.println("##TOTAL\t" + totalSeen);
			w.println("##LOCAL\t" + localSeen);
			w.println("##TARGETS\t" + targets.size());
			w.println("##SUCCEEDED\t" + ok);
			w.println("##FAILED\t" + failed);
			w.println("##SKIPPED\t" + skipped);
			w.println("##WROTE\t" + ok);
		}
		println("REA: decompiled " + ok + "/" + targets.size() + " (failed " + failed
			+ ", skipped " + skipped + ")");
	}

	/** One inventory row per function. */
	private static String row(Function f, String status, String err) {
		return "##FUNC\t" + f.getEntryPoint() + "\t" + clean(f.getName()) + "\t"
			+ f.getBody().getNumAddresses() + "\t" + status + "\t" + err;
	}

	/** True when the symbol's provenance marks it as imported from a library. */
	private static boolean isImported(Function f) {
		return f.getSymbol() != null && f.getSymbol().getSource() != null
			&& f.getSymbol().getSource().toString().startsWith("IMPORTED");
	}

	/** True when at least one function carries IMPORTED provenance. */
	private static boolean hasImportedProvenance(FunctionManager fm) {
		FunctionIterator it = fm.getFunctions(true);
		while (it.hasNext()) {
			if (isImported(it.next())) {
				return true;
			}
		}
		return false;
	}

	private String fileStem(Function f) {
		String addr = f.getEntryPoint().toString().toLowerCase();
		String name = clean(f.getName()).replaceAll("[^A-Za-z0-9_.]", "_");
		if (name.length() > 70) {
			name = name.substring(0, 70);
		}
		return addr + "_" + name;
	}

	private void writeC(File out, Function f, String body) throws Exception {
		StringBuilder sb = new StringBuilder();
		sb.append("/* ").append(f.getName()).append('\n');
		sb.append(" * ").append(f.getSignature().getPrototypeString(true)).append('\n');
		sb.append(" * address: 0x").append(f.getEntryPoint()).append('\n');
		sb.append(" * size: ").append(f.getBody().getNumAddresses()).append(" bytes\n");
		sb.append(" * program: ").append(currentProgram.getName()).append('\n');
		sb.append(" */\n\n");
		sb.append(body == null ? "/* no pseudocode returned */\n" : body);
		try (PrintWriter w = new PrintWriter(new FileWriter(out))) {
			w.print(sb);
		}
	}

	private void writeAsm(File out, Function f) throws Exception {
		StringBuilder sb = new StringBuilder();
		sb.append("; ").append(f.getName()).append("  @ 0x").append(f.getEntryPoint()).append('\n');
		sb.append("; signature: ").append(f.getSignature().getPrototypeString(true)).append('\n');
		InstructionIterator ii = currentProgram.getListing().getInstructions(f.getBody(), true);
		while (ii.hasNext()) {
			Instruction ins = ii.next();
			sb.append(ins.getAddress().toString()).append("  ")
				.append(ins.toString().trim()).append('\n');
		}
		try (PrintWriter w = new PrintWriter(new FileWriter(out))) {
			w.print(sb);
		}
	}

	private static String clean(String s) {
		if (s == null) {
			return "";
		}
		return s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ').trim();
	}
}
