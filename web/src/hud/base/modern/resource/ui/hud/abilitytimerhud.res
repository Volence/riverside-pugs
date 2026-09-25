"Resource/UI/HUD/AbilityTimerHud.res"
{
	"BackgroundImage"
	{
		"ControlName"	"ImagePanel"
		"fieldName"	"BackgroundImage"
		"xpos"	"0"
		"ypos"	"0"
		"wide"	"0"
		"tall"	"0"
		"visible"	"0"
		"enabled"	"0"
		"zpos"	"0"
	}
	"AbilityImage"
	{
		"ControlName"	"ImagePanel"
		"fieldName"	"AbilityImage"
		"xpos"	"5"
		"ypos"	"5"
		"wide"	"46"
		"tall"	"46"
		"visible"	"1"
		"enabled"	"1"
		"scaleImage"	"1"
		"zpos"	"1"
	}
	"Progress"
	{
		"ControlName"	"CircularProgressBar"
		"fieldName"	"Progress"
		"xpos"	"0"
		"ypos"	"0"
		"wide"	"56"
		"tall"	"56"
		"visible"	"1"
		"enabled"	"1"
		"zpos"	"2"
		"fg_image"	"HUD/PZ_charge_meter"
		"variable"	"abilityProgress"
		"bgcolor_override"	"0 0 0 0"
	}
}
