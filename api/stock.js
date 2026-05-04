export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol is required' });

  const FINAGE_KEY = process.env.FINAGE_API_KEY;
  const FMP_KEY = process.env.FMP_API_KEY;
  const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY;

  try {
    const s = encodeURIComponent(symbol.toUpperCase());
    let priceData = null;
    let fundamentalsData = null;

    // --- STEP 1: GET PRICE DATA ---
    // Try Finage first (Super fast for price/quotes), fallback to FMP
    if (FINAGE_KEY) priceData = await fetchPriceFromFinage(s, FINAGE_KEY);
    if (!priceData && FMP_KEY) priceData = await fetchPriceFromFMP(s, FMP_KEY);
    if (!priceData && AV_KEY) priceData = await fetchPriceFromAV(s, AV_KEY);

    if (!priceData) return res.status(404).json({ error: 'Could not fetch price data for this symbol.' });

    // --- STEP 2: GET FUNDAMENTAL DATA (Income Statements) ---
    if (FMP_KEY) fundamentalsData = await fetchFundamentalsFromFMP(s, FMP_KEY);
    if (!fundamentalsData && AV_KEY) fundamentalsData = await fetchFundamentalsFromAV(s, AV_KEY);

    if (!fundamentalsData) return res.status(404).json({ error: 'Could not fetch financial statements. Add FMP_API_KEY.' });

    // --- MERGE DATA ---
    const data = { ...priceData, ...fundamentalsData };
    const { name, sector, industry, exchange, marketCap, beta, trailingPE, pbRatio, psRatio, pegRatio, eps, bookValuePS, sharesOut, revenuePerShare, profitMargin, roe, dividendYield, analystTarget, qEarningsGrowth, qRevenueGrowth, netIncomes, revenues, currentPrice } = data;

    if (currentPrice <= 0) return res.status(404).json({ error: 'Invalid current price.' });

    // --- MATH ENGINE ---
    let growthRate = 0;
    if (qEarningsGrowth > 0) growthRate = Math.min(qEarningsGrowth, 0.30);
    else if (qRevenueGrowth > 0) growthRate = Math.min(qRevenueGrowth, 0.25);
    else if (netIncomes.length >= 2) { const prev = netIncomes[1]; if (prev > 0) growthRate = Math.min((netIncomes[0] - prev) / Math.abs(prev), 0.20); }
    if (growthRate <= 0) growthRate = 0.05;

    let revenueCAGR = null, netIncomeCAGR = null;
    if (revenues && revenues.length >= 5) { const sorted = [...revenues].reverse(); if (sorted[0] > 0 && sorted[4] > 0) revenueCAGR = Math.pow(sorted[4] / sorted[0], 1 / 4) - 1; }
    if (netIncomes && netIncomes.length >= 5) { const sorted = [...netIncomes].reverse(); if (sorted[0] > 0 && sorted[4] > 0) netIncomeCAGR = Math.pow(sorted[4] / sorted[0], 1 / 4) - 1; }

    const riskFree = 0.045, mktPrem = 0.055;
    const wacc = Math.max(0.08, Math.min(0.15, riskFree + (beta || 1) * mktPrem));

    let grahamNumber = null; if (eps > 0 && bookValuePS > 0) grahamNumber = Math.sqrt(22.5 * eps * bookValuePS);
    let epv = null; if (netIncomes.length >= 1 && sharesOut > 0) { const avgNI = netIncomes.reduce((a, b) => a + b, 0) / netIncomes.length; if (avgNI / sharesOut > 0) epv = (avgNI / sharesOut) / wacc; }
    let peterLynchValue = null; if (eps > 0 && growthRate > 0) peterLynchValue = eps * (1 + growthRate);
    let peterLynchGrowthValue = null; if (eps > 0 && growthRate > 0) peterLynchGrowthValue = eps * Math.pow(1 + growthRate, 5);
    let psFairValue = null; if (revenuePerShare > 0) { let fairPS = profitMargin > 0.20 ? 4.0 : profitMargin > 0.15 ? 3.0 : profitMargin > 0.10 ? 2.0 : profitMargin > 0.05 ? 1.5 : profitMargin > 0 ? 1.0 : 0.8; psFairValue = revenuePerShare * fairPS; }
    
    let dcfValue = null;
    if (sharesOut > 0 && netIncomes.length >= 1 && netIncomes[0] > 0) {
      let projFCF = netIncomes[0]; let totalPV = 0;
      for (let i = 1; i <= 5; i++) { projFCF *= (1 + growthRate); totalPV += projFCF / Math.pow(1 + wacc, i); }
      totalPV += (projFCF * 1.03) / ((wacc - 0.03) * Math.pow(1 + wacc, 5));
      dcfValue = totalPV / sharesOut;
    }

    let gfValue = null; const wMap = { dcf: 0.35, epv: 0.30, peterLynch: 0.20, graham: 0.15 }; let wSum = 0, wTotal = 0;
    const isValid = (v) => v !== null && v !== undefined && isFinite(v) && v > 0 && v < currentPrice * 100;
    if (isValid(dcfValue)) { wSum += dcfValue * wMap.dcf; wTotal += wMap.dcf; }
    if (isValid(epv)) { wSum += epv * wMap.epv; wTotal += wMap.epv; }
    if (isValid(peterLynchValue)) { wSum += peterLynchValue * wMap.peterLynch; wTotal += wMap.peterLynch; }
    if (isValid(grahamNumber)) { wSum += grahamNumber * wMap.graham; wTotal += wMap.graham; }
    if (wTotal > 0) gfValue = wSum / wTotal;

    let marginOfSafety = null; if (gfValue && gfValue > 0) marginOfSafety = ((gfValue - currentPrice) / gfValue) * 100;
    const r = v => v !== null && v !== undefined && isFinite(v) ? Math.round(v * 100) / 100 : null;

    res.status(200).json({
      currentPrice: r(currentPrice), gfValue: r(gfValue), epv: r(epv), peterLynchValue: r(peterLynchValue), peterLynchGrowthValue: r(peterLynchGrowthValue),
      grahamNumber: r(grahamNumber), psFairValue: r(psFairValue), dcfValue: r(dcfValue), analystTarget: analystTarget > 0 ? r(analystTarget) : null,
      marginOfSafety: marginOfSafety !== null ? Math.round(marginOfSafety * 10) / 10 : null,
      revenueCAGR: revenueCAGR !== null ? Math.round(revenueCAGR * 1000) / 10 : null, netIncomeCAGR: netIncomeCAGR !== null ? Math.round(netIncomeCAGR * 1000) / 10 : null,
      info: { name: name || symbol, symbol: symbol.toUpperCase(), sector: sector || 'N/A', industry: industry || 'N/A', exchange: exchange || 'N/A', marketCap: marketCap || 0, peRatio: r(trailingPE), pbRatio: bookValuePS > 0 ? r(currentPrice / bookValuePS) : null, psRatio: r(psRatio), pegRatio: pegRatio > 0 ? r(pegRatio) : null, beta: beta || 1, roe, profitMargin, eps: r(eps), bookValue: r(bookValuePS), growthRate: r(growthRate), dividendYield }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ==========================================
// 1. PRICE DATA PROVIDERS
// ==========================================
async function fetchPriceFromFinage(symbol, apiKey) {
  try {
    // Finage US Stock endpoint
    const res = await fetch(`https://api.finage.co.uk/last/stock/${symbol}?apikey=${apiKey}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.ask || d.ask <= 0) return null;
    
    // Finage gives raw price, we need to estimate the rest or let FMP fill it
    return {
      currentPrice: d.ask,
      exchange: 'US Market' // Finage doesn't provide name/sector easily on free tier
    };
  } catch (e) { return null; }
}

async function fetchPriceFromFMP(symbol, apiKey) {
  try {
    const res = await fetch(`https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${apiKey}`).then(r => r.json());
    if (!res || res.length === 0 || res.Error) return null;
    const p = res[0]; const price = parseFloat(p.price) || 0; if (price <= 0) return null;
    return {
      name: p.companyName, sector: p.sector, industry: p.industry, exchange: p.exchangeShortName, marketCap: parseFloat(p.mktCap) || 0,
      beta: parseFloat(p.beta) || 1, trailingPE: parseFloat(p.pe) || 0, psRatio: parseFloat(p.priceToSalesRatioTTM) || 0,
      pegRatio: parseFloat(p.pegRatio) || 0, eps: parseFloat(p.earningsPerShareBasicTTM) || 0, bookValuePS: parseFloat(p.bookValuePerShare) || 0,
      sharesOut: price > 0 ? (parseFloat(p.mktCap) || 0) / price : 0, revenuePerShare: parseFloat(p.revenuePerShareTTM) || 0,
      profitMargin: parseFloat(p.profitMargin) || 0, roe: parseFloat(p.returnOnEquityTTM) || 0, dividendYield: parseFloat(p.dividend) || 0,
      analystTarget: parseFloat(p.analystTargetPrice) || 0, qEarningsGrowth: parseFloat(p.quarterlyEarningsGrowthYOY) || 0,
      qRevenueGrowth: parseFloat(p.quarterlyRevenueGrowthYOY) || 0, currentPrice: price
    };
  } catch (e) { return null; }
}

async function fetchPriceFromAV(symbol, apiKey) {
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json());
    if (res['Error Message'] || res['Note'] || res['Information']) return null;
    const eps = parseFloat(res.EPS) || 0; const bookValuePS = parseFloat(res.BookValue) || 0; const sharesOut = parseFloat(res.SharesOutstanding) || 0; const trailingPE = parseFloat(res.TrailingPE) || 0; const marketCap = parseFloat(res.MarketCapitalization) || 0;
    let currentPrice = 0; if (marketCap > 0 && sharesOut > 0) currentPrice = marketCap / sharesOut; else if (trailingPE > 0 && eps > 0) currentPrice = eps * trailingPE; if (currentPrice <= 0) return null;
    return { name: res.Name, sector: res.Sector, industry: res.Industry, exchange: res.Exchange, marketCap, beta: parseFloat(res.Beta) || 1, trailingPE, psRatio: parseFloat(res.PriceToSalesRatioTTM) || 0, pegRatio: parseFloat(res.PEGRatio) || 0, eps, bookValuePS, sharesOut, revenuePerShare: parseFloat(res.RevenuePerShareTTM) || 0, profitMargin: parseFloat(res.ProfitMargin) || 0, roe: parseFloat(res.ReturnOnEquityTTM) || 0, dividendYield: parseFloat(res.DividendYield) || 0, analystTarget: parseFloat(res.AnalystTargetPrice) || 0, qEarningsGrowth: parseFloat(res.QuarterlyEarningsGrowthYOY) || 0, qRevenueGrowth: parseFloat(res.QuarterlyRevenueGrowthYOY) || 0, currentPrice };
  } catch (e) { return null; }
}

// ==========================================
// 2. FUNDAMENTAL DATA PROVIDERS (Income Statements)
// ==========================================
async function fetchFundamentalsFromFMP(symbol, apiKey) {
  try {
    const incomeRes = await fetch(`https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=5&apikey=${apiKey}`).then(r => r.json());
    if (!Array.isArray(incomeRes)) return null;
    return {
      netIncomes: incomeRes.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0),
      revenues: incomeRes.slice(0, 5).map(r => parseFloat(r.revenue) || 0).filter(v => v !== 0)
    };
  } catch (e) { return null; }
}

async function fetchFundamentalsFromAV(symbol, apiKey) {
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json());
    if (res['Error Message'] || res['Note'] || res['Information']) return null;
    const annualReports = res.annualReports || [];
    const reversed = [...annualReports].reverse();
    return {
      netIncomes: reversed.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0),
      revenues: reversed.slice(0, 5).map(r => parseFloat(r.totalRevenue) || 0).filter(v => v !== 0)
    };
  } catch (e) { return null; }
}
