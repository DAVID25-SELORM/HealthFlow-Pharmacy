# Drug Import from Excel - User Guide

## Overview

HealthFlow Pharmacy now supports bulk import of drugs from Excel files, making it easy to add multiple medicines at once.

## Quick Start

### 1. Download Template

1. Go to **Inventory** page
2. Click **Download Template** button
3. An Excel file `drug_import_template.xlsx` will be downloaded with sample data

### 2. Prepare Your Data

Open the downloaded template in Excel, Google Sheets, or any spreadsheet software. The template includes these columns:

#### Required Columns:
- **name**: Drug name (e.g., "Paracetamol 500mg")
- **batch_number**: Batch/lot number (e.g., "BT001")
- **expiry_date**: Expiry date in YYYY-MM-DD format (e.g., "2026-12-31")
- **quantity**: Number of units (e.g., 500)
- **price**: Selling price in GHS (e.g., 5.00)

#### Optional Columns:
- **cost_price**: Purchase cost per unit
- **supplier**: Supplier name
- **category**: Drug category (e.g., "Antibiotics", "Pain Relief")
- **description**: Additional notes
- **reorder_level**: Minimum stock before reorder alert (default: 10)
- **unit**: Unit of measurement (default: "tablets")

### 3. Fill  Data

Replace the sample data with your actual drug inventory. You can:
- Delete the sample rows
- Add as many drugs as you need (recommended max: 500 per file for best performance)
- Keep the column headers exactly as shown
- Use YYYY-MM-DD format for dates (e.g., 2026-08-15)

**Example:**
```
name                    | batch_number | expiry_date | quantity | price | cost_price | supplier          | category
Amoxicillin 500mg      | BT001        | 2026-08-15  | 200      | 37.00 | 25.00      | Beta Healthcare   | Antibiotics
Paracetamol 500mg      | BT002        | 2026-12-31  | 500      | 5.00  | 3.00       | PharmaCare Ltd    | Pain Relief
```

### 4. Import the File

1. Go to **Inventory** page
2. Click **Import Excel** button
3. Select your prepared Excel file
4. Review the import preview:
   - **Valid Rows**: Drugs that will be imported
   - **Invalid Rows**: Drugs with errors (will be skipped)
5. Fix any errors shown (if needed)
6. Click **Import X Drug(s)** to complete

## Validation Rules

The system validates each row before import:

### ✅ Valid Drug Requirements:
- Drug name must not be empty
- Batch number must not be empty
- Expiry date must be in YYYY-MM-DD format
- Quantity must be 0 or greater
- Price must be 0 or greater

### ❌ Common Errors:
- **"Drug name is required"**: Name column is empty
- **"Batch number is required"**: Batch number column is empty
- **"Expiry date must be in YYYY-MM-DD format"**: Wrong date format (use 2026-12-31, not 31/12/2026)
- **"Quantity must be non-negative"**: Negative quantity entered
- **"Price must be non-negative"**: Negative price entered

## ImportResults

After importing:
- **Success**: Green notification shows how many drugs were imported
- **Partial Success**: Yellow notification if some drugs failed (usually duplicates)
- **Failed**: Red notification with error details

### Duplicate Handling

If a drug with the same **name + batch number** already exists:
- The import will skip that row
- Existing drug data remains unchanged
- Other valid rows will still be imported

## Tips & Best Practices

### ✅ Best Practices:
1. **Start Small**: Test with 5-10 drugs first
2. **Check Template**: Download the template before creating your own file
3. **Use Consistent Format**: Keep date format as  YYYY-MM-DD throughout
4. **Review Preview**: Always review the preview before confirming import
5. **Backup Data**: Export existing inventory before bulk imports

### ⚠️ Things to Avoid:
1. Don't change column names in the template
2. Don't use merged cells
3. Don't leave required fields empty
4. Don't use formulas in cells (paste values only)
5. Don't import more than 500 drugs at once (split into multiple files)

## Troubleshooting

### "Missing required columns" Error
**Problem**: Column headers don't match template  
**Solution**: Download template again and copy/paste your data

### "Excel file is empty" Error
**Problem**: No data rows in the file  
**Solution**: Ensure you have data below the header row

### All Rows Show as Invalid
**Problem**: Date format or missing required fields  
**Solution**: Check that dates are YYYY-MM-DD and all required columns are filled

### Import Button is Disabled
**Problem**: No valid rows to import  
**Solution**: Fix the errors shown in the preview section

### Some Drugs Not Imported
**Problem**: Duplicates or constraint violations  
**Solution**: Check the warning message - usually indicates duplicate name+batch combinations

## Column Reference

| Column | Required | Type | Example | Notes |
|--------|----------|------|---------|-------|
| name | Yes | Text | Paracetamol 500mg | Include strength |
| batch_number | Yes | Text | BT001 | Unique per batch |
| expiry_date | Yes | Date | 2026-12-31 | YYYY-MM-DD format only |
| quantity | Yes | Number | 500 | Must be ≥ 0 |
| price | Yes | Decimal | 5.00 | Selling price in GHS |
| cost_price | No | Decimal | 3.00 | Purchase cost |
| supplier | No | Text | PharmaCare Ltd | Supplier name |
| category | No | Text | Pain Relief | Drug category |
| description | No | Text | Analgesic | Additional info |
| reorder_level | No | Number | 100 | Alert threshold |
| unit | No | Text | tablets | e.g., tablets, capsules, ml |

## Support

For help with importing drugs:
- Check the validation errors in the preview
- Verify your file matches the template format
- Contact support: gabiondavidselorm@gmail.com

---

**Last Updated**: April 15, 2026  
**Feature**: Excel Import for Drug Inventory  
**Developer**: David Gabion Selorm
